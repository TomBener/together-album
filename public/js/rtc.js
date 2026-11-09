// WebRTC 点对点传输。照片走加密的 DataChannel（DTLS），服务器只转发建立连接用的信令。
// 能直连时直连；直连不通时经 TURN 中继转发，中继只见到加密后的数据。
//
// 每条连接有两个通道，都按顺序、可靠送达。
//
// 控制通道 album：消息少而小，不排在照片数据后面，翻页消息马上到
//   分享者 → 观看者 { t: 'show', id, index, total, key } 翻到了哪张；key 是这张照片的钥匙（不能加密时没有）
//                  { t: 'viewers', count } 现在有几人在看（含对方自己），和分享者那边显示的人数一致
//                  { t: 'end' } 分享结束
//   观看者 → 分享者 { t: 'have', parts: ['照片id:preview', '照片id:full', …], need } 已经能显示的照片，新连接不必重发；
//                  need 是这块屏幕全屏看照片时，照片长边最多要多少像素
//   双向           { t: 'here', on } 自己的页面在不在前台。切到别的 App、锁屏、关掉页面时马上告诉对方，
//                  对方状态栏显示“暂时离开”，不用等连接超时（要几十秒）
//
// 照片通道 photos：
//   { t: 'photo', n, id, kind, size, type, iv } 开始第 n 次传输：照片 id 的预览（preview）、原画质（full）
//       或给大屏幕的大一档原画质（large），共 size 字节；带 iv 时数据用这张照片的钥匙加密过
//   二进制分片：前 4 字节是 n，后面是数据。几次传输的分片可以交错，同一次传输的分片按顺序
//   { t: 'drop', n } 第 n 次传输不发了（分享者翻远了），观看者丢掉已收到的部分
//
// 分享者按 plan.js 的先后发：当前这张的预览、原画质，再提前发前后几张；大屏幕直连时，当前这张再补发
// 大一档的。提前发的照片锁着（seal.js），观看者收到 show 里的钥匙才能打开，所以分享者翻到哪张，
// 对方才能看到哪张。

import { sendPlan } from './plan.js';
import { canSeal } from './seal.js';

const CHUNK = 16 * 1024; // 每条消息的大小上限，各浏览器都能稳定收发（Safari 的上限比 Chrome 小）
const HEAD = 4; // 分片开头的传输编号
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
// 照片通道里排队等发的数据上限。分享者翻到还没发的照片时，要先等这些发完，所以不能排太多；
// 中转时慢，排得更少。翻页消息走控制通道，不受影响
const QUEUE_DIRECT = 512 * 1024;
const QUEUE_RELAYED = 128 * 1024;
const HAVE_WAIT_MS = 1000; // 新连接先等观看者说明手里有哪些照片，再开始发；等不到也照常发
const NEGOTIATE_MS = 15_000; // 一次连接尝试这么久还没连上，就算失败，有机会就重来
const SIGNAL_RETRY_MS = 30_000; // 信令发不出去时（对方或自己的实时通道正好断了）最多重发这么久
// 网址带 ?relay=1 时只走中继，用来测试中转的速度
const FORCE_RELAY = new URLSearchParams(location.search).has('relay');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randomId(bytes = 16) {
  // crypto.randomUUID 只在 HTTPS 下可用，局域网 http 也要能跑
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function linkState(pc) {
  const state = pc.connectionState ?? pc.iceConnectionState;
  return state === 'checking' || state === 'new' ? 'connecting' : state;
}

function peerConnection(iceServers) {
  return new RTCPeerConnection({ iceServers, iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' });
}

/**
 * 发一条信令。对方或自己的实时通道正好断开时服务器会退回（403/404），网络出错时 fetch 会抛错，
 * 这些情况下稍后重发，直到发出去、这条连接作废（alive() 为假）或超时。
 */
async function deliver(signal, data, alive) {
  const deadline = Date.now() + SIGNAL_RETRY_MS;
  for (let wait = 500; ; wait = Math.min(wait * 2, 4000)) {
    try {
      return await signal(data);
    } catch (err) {
      const retry = !err.status || err.status === 403 || err.status === 404 || err.status === 429 || err.status >= 500;
      if (!retry || Date.now() + wait > deadline) throw err;
      await sleep(wait);
      if (!alive()) throw err;
    }
  }
}

/** 这条连接现在是不是经 TURN 中继。各浏览器标出“正在用的那一对地址”的方式不同，依次尝试。 */
async function isRelayed(pc) {
  try {
    const stats = await pc.getStats();
    const all = [...stats.values()];
    const id = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId;
    const pair =
      (id && stats.get(id)) ??
      all.find((s) => s.type === 'candidate-pair' && s.selected) ??
      all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    if (!pair) return false;
    return [pair.localCandidateId, pair.remoteCandidateId].some((c) => stats.get(c)?.candidateType === 'relay');
  } catch {
    return false;
  }
}

/** 分享者这一端：每位观看者一条。 */
export class HostLink {
  constructor(peerId, { iceServers, signal, onChange }) {
    this.peerId = peerId;
    this.id = randomId(8); // 区分同一观看者的新旧连接，过期的信令直接丢弃
    this.onChange = onChange;
    this.started = Date.now();
    this.closed = false;
    this.relayed = false;
    this.wasOpen = false; // 连上过。之后断开时，分享者那边显示“朋友暂时离开”
    this.here = true; // 观看者的页面在前台
    this.need = 0; // 观看者的屏幕全屏看照片时，照片长边要多少像素
    this.viewers = null;
    this.focused = null; // { photos, index }：分享者翻到哪张
    this.showed = '';
    this.done = new Set(); // 对方已经有的 '照片id:版本'
    this.transfers = new Map(); // '照片id:版本' → { n, header, bytes, offset, started }
    this.count = 0;
    this.synced = false; // 收到了对方的 have，或者等过了
    this.pumping = false;
    this.again = false;
    this.pending = [];
    this.outbox = Promise.resolve();
    this.inbox = Promise.resolve();
    this.send = (data) => {
      // 信令逐条发送，保证对方按 offer → candidate 的顺序收到；发不出去就等一等重发，后面的排队
      const message = { ...data, link: this.id };
      this.outbox = this.outbox.then(() => deliver(signal, message, () => !this.closed)).catch(() => {});
    };

    const pc = (this.pc = peerConnection(iceServers));
    // 必须先建通道再 createOffer，否则 SDP 里没有数据通道
    this.control = pc.createDataChannel('album', { ordered: true });
    this.data = pc.createDataChannel('photos', { ordered: true });
    this.data.binaryType = 'arraybuffer';
    this.data.bufferedAmountLowThreshold = QUEUE_RELAYED / 4;
    this.data.onbufferedamountlow = () => this.pump();
    this.control.onopen = this.data.onopen = () => this.opened();
    this.control.onclose = this.data.onclose = () => this.onChange(this);
    this.control.onmessage = ({ data }) => this.onControl(data);
    pc.onicecandidate = (e) => e.candidate && this.send({ candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => this.onChange(this);
    this.start();
  }

  async start() {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.send({ sdp: this.pc.localDescription.toJSON() });
    } catch {
      this.onChange(this);
    }
  }

  get open() {
    return this.control.readyState === 'open' && this.data.readyState === 'open';
  }

  get state() {
    return this.open ? 'open' : linkState(this.pc);
  }

  /** 连接已经失败，或者尝试了太久还没连上：再有机会（对方重连信令等）时就重新建立。 */
  get stale() {
    if (this.open) return false;
    const state = this.state;
    return state === 'failed' || state === 'closed' || Date.now() - this.started > NEGOTIATE_MS;
  }

  /** 观看者正在看：连着、页面在前台、网络没有中断。 */
  get present() {
    return this.open && this.here && linkState(this.pc) !== 'disconnected';
  }

  get queueLimit() {
    return this.relayed ? QUEUE_RELAYED : QUEUE_DIRECT;
  }

  receive(data) {
    if (data.link !== this.id) return;
    this.inbox = this.inbox.then(() => this.process(data)).catch(() => {});
  }

  async process(data) {
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (!this.pc.remoteDescription) this.pending.push(data.candidate);
      else await this.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  // 两个通道都打开了：先告诉对方翻到哪张，等对方说明手里有哪些照片后开始发
  opened() {
    if (!this.open || this.wasOpen) return;
    this.wasOpen = true;
    setTimeout(() => this.sync(), HAVE_WAIT_MS);
    this.onChange(this);
    this.sendHere(document.visibilityState === 'visible');
    this.announce();
    this.route();
  }

  /** 告诉观看者分享者的页面在不在前台。 */
  sendHere(on) {
    this.sendControl({ t: 'here', on });
  }

  // 看一眼是不是经中转：刚连上时可能先走中转，过一会儿换成直连
  async route() {
    const relayed = await isRelayed(this.pc);
    if (this.closed) return;
    this.data.bufferedAmountLowThreshold = (relayed ? QUEUE_RELAYED : QUEUE_DIRECT) / 4;
    if (relayed === this.relayed) return;
    this.relayed = relayed;
    this.onChange(this);
    // 直连时才给大屏幕发大一档的（plan.js），所以换路以后重新排
    this.replan();
    this.pump();
  }

  onControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'have' && Array.isArray(msg.parts)) {
      for (const part of msg.parts) if (typeof part === 'string') this.done.add(part);
      this.need = Number(msg.need) || 0;
      this.sync();
    } else if (msg.t === 'here') {
      this.here = msg.on !== false;
      this.onChange(this);
    }
  }

  sync() {
    if (this.synced || this.closed) return;
    this.synced = true;
    this.replan();
    this.pump();
  }

  /** 分享者翻到了第 index 张，或者照片张数变了。 */
  focus(photos, index) {
    this.focused = { photos, index };
    this.announce();
    this.replan();
    this.pump();
  }

  // 告诉对方现在翻到哪张，附上这张的钥匙
  announce() {
    const photo = this.focused?.photos[this.focused.index];
    if (!photo || !this.open) return;
    const { photos, index } = this.focused;
    const signature = `${photo.id}|${index}|${photos.length}`;
    if (signature === this.showed) return;
    this.showed = signature;
    this.sendControl({ t: 'show', id: photo.id, index, total: photos.length, key: photo.secret ?? undefined });
    this.route();
  }

  // 还要发的 [照片, 版本]，按先后排好（plan.js）
  plan() {
    if (!this.focused) return [];
    const { photos, index } = this.focused;
    return sendPlan({ photos, index, done: this.done, need: this.need, direct: !this.relayed, ahead: canSeal });
  }

  // 分享者翻远了：不再需要的传输停下，告诉对方丢掉收到一半的
  replan() {
    const wanted = new Set(this.plan().map(([photo, kind]) => `${photo.id}:${kind}`));
    for (const [part, transfer] of this.transfers) {
      if (wanted.has(part)) continue;
      this.transfers.delete(part);
      if (transfer.started) {
        try {
          this.data.send(JSON.stringify({ t: 'drop', n: transfer.n }));
        } catch {
          // 已断开
        }
      }
    }
  }

  // 按先后把数据放进照片通道，排满为止；排着的数据发出去一些后（bufferedamountlow）再接着放。
  // 同一时间只跑一个，别处要求再跑时记一笔，跑完这一轮再看一遍
  async pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (this.synced && this.open && this.data.bufferedAmount < this.queueLimit) {
          const next = this.plan()[0];
          if (!next) break;
          const [photo, kind] = next;
          const part = `${photo.id}:${kind}`;
          let transfer = this.transfers.get(part);
          if (!transfer) {
            transfer = { n: ++this.count, header: null, bytes: null, offset: 0, started: false };
            this.transfers.set(part, transfer);
            let payload;
            try {
              payload = await photo.payload(kind);
            } catch {
              // 这个版本生成不了：跳过，不卡住后面的
              this.transfers.delete(part);
              this.done.add(part);
              continue;
            }
            if (this.transfers.get(part) !== transfer) continue; // 等的时候分享者翻远了
            transfer.bytes = payload.bytes;
            transfer.header = { t: 'photo', n: transfer.n, id: photo.id, kind, size: payload.bytes.byteLength, type: payload.type, iv: payload.iv };
          }
          if (!this.open) break;
          if (!transfer.started) {
            this.data.send(JSON.stringify(transfer.header));
            transfer.started = true;
          }
          const { bytes } = transfer;
          while (transfer.offset < bytes.byteLength && this.data.bufferedAmount < this.queueLimit) {
            const end = Math.min(transfer.offset + CHUNK - HEAD, bytes.byteLength);
            const chunk = new Uint8Array(HEAD + end - transfer.offset);
            new DataView(chunk.buffer).setUint32(0, transfer.n);
            chunk.set(bytes.subarray(transfer.offset, end), HEAD);
            this.data.send(chunk);
            transfer.offset = end;
          }
          if (transfer.offset < bytes.byteLength) break; // 排满了，等发出去一些
          this.transfers.delete(part);
          this.done.add(part);
        }
      } while (this.again);
    } catch {
      // 通道中途断开；重新连上后会建新的 HostLink，对方说明已有哪些照片后接着发
    } finally {
      this.pumping = false;
    }
  }

  sendControl(msg) {
    try {
      if (this.control.readyState === 'open') this.control.send(JSON.stringify(msg));
    } catch {
      // 已断开
    }
  }

  /** 告诉对方现在有几人在看。按条记住发过的数，换了新连接的观看者即使总数没变也会收到。 */
  setViewers(count) {
    if (!this.open || this.viewers === count) return;
    this.sendControl({ t: 'viewers', count });
    this.viewers = count;
  }

  /** 告诉对方分享结束（对方会立即清除照片），然后断开。 */
  end() {
    this.sendControl({ t: 'end' });
    setTimeout(() => this.close(), 300);
  }

  close() {
    this.closed = true;
    this.focused = null;
    this.transfers.clear();
    this.control.onclose = this.data.onclose = null;
    this.pc.close();
  }
}

/** 观看者这一端：接受分享者的连接，收照片和翻页指令。 */
export class ViewerLink {
  constructor({ iceServers, signal, have, onState, onRoute, onPart, onShow, onViewers, onProgress, onHere, onEnd }) {
    this.iceServers = iceServers;
    this.signal = signal;
    this.have = have; // () => { parts: 已经能显示的 '照片id:版本', need: 屏幕要的像素 }，新连接上告诉分享者
    this.on = { onState, onRoute, onPart, onShow, onViewers, onProgress, onHere, onEnd };
    this.pc = null;
    this.control = null;
    this.linkId = null;
    this.pending = [];
    this.inbox = Promise.resolve();
    this.outbox = Promise.resolve();
  }

  send(data) {
    // 逐条发送，发不出去就等一等重发；分享者换了新连接，旧连接的信令就不再重发
    const link = this.linkId;
    this.outbox = this.outbox
      .then(() => deliver(this.signal, { ...data, link }, () => this.linkId === link))
      .catch(() => {});
  }

  receive(data) {
    this.inbox = this.inbox.then(() => this.process(data)).catch(() => this.on.onState('failed'));
  }

  async process(data) {
    if (data.sdp?.type === 'offer') {
      this.reset();
      this.linkId = data.link;
      this.outbox = Promise.resolve(); // 新连接的信令不必排在旧连接的重发后面
      const pc = (this.pc = peerConnection(this.iceServers));
      const current = () => pc === this.pc;
      pc.onicecandidate = (e) => e.candidate && current() && this.send({ candidate: e.candidate.toJSON() });
      pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => {
        if (!current()) return;
        const state = linkState(pc);
        // 短暂断开又恢复时，通道一直开着，不会再收到 open 事件，要在这里报回“已连上”
        this.on.onState(state === 'connected' && this.control?.readyState === 'open' ? 'open' : state);
      };
      pc.ondatachannel = ({ channel }) => {
        if (!current()) return; // 旧连接晚到的通道不要
        if (channel.label === 'photos') this.attachPhotos(channel, current);
        else this.attachControl(channel, pc, current);
      };
      this.on.onState('connecting');
      await pc.setRemoteDescription(data.sdp);
      for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      this.send({ sdp: pc.localDescription.toJSON() });
    } else if (data.candidate && data.link === this.linkId) {
      if (!this.pc?.remoteDescription) this.pending.push(data.candidate);
      else await this.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  /** 告诉分享者观看者的页面在不在前台。 */
  sendHere(on) {
    try {
      if (this.control?.readyState === 'open') this.control.send(JSON.stringify({ t: 'here', on }));
    } catch {
      // 已断开
    }
  }

  attachControl(channel, pc, current) {
    this.control = channel;
    let done = false;
    // 浏览器可能在通道已经打开时才交给我们，之后又触发一次 open 事件，只处理一次
    const opened = () => {
      if (done || !current()) return;
      done = true;
      // 先说明手里已有哪些照片，分享者就不必重发
      try {
        channel.send(JSON.stringify({ t: 'have', ...this.have() }));
      } catch {
        // 已断开
      }
      this.sendHere(document.visibilityState === 'visible');
      this.on.onState('open');
      isRelayed(pc).then((relayed) => current() && this.on.onRoute?.(relayed));
    };
    channel.onopen = opened;
    if (channel.readyState === 'open') opened();
    channel.onclose = () => current() && this.on.onState('closed');
    channel.onmessage = ({ data }) => {
      if (!current() || typeof data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'show') this.on.onShow(msg);
      else if (msg.t === 'viewers') this.on.onViewers(msg.count);
      else if (msg.t === 'here') this.on.onHere?.(msg.on !== false);
      else if (msg.t === 'end') this.on.onEnd();
    };
  }

  attachPhotos(channel, current) {
    channel.binaryType = 'arraybuffer';
    const incoming = new Map(); // 传输编号 → { id, kind, size, type, iv, chunks, received }
    channel.onmessage = ({ data }) => {
      if (!current()) return;
      if (typeof data === 'string') {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.t === 'photo') {
          const valid = msg.size > 0 && msg.size <= MAX_PHOTO_BYTES && ['preview', 'full', 'large'].includes(msg.kind);
          if (valid) incoming.set(msg.n, { ...msg, chunks: [], received: 0 });
        } else if (msg.t === 'drop') {
          incoming.delete(msg.n); // 不认识的编号（已经收完的）什么也不做
        }
        return;
      }
      if (data.byteLength <= HEAD) return;
      const part = incoming.get(new DataView(data).getUint32(0));
      if (!part) return;
      part.chunks.push(new Uint8Array(data, HEAD));
      part.received += data.byteLength - HEAD;
      this.on.onProgress({ id: String(part.id), kind: part.kind, fraction: Math.min(part.received / part.size, 1) });
      if (part.received < part.size) return;
      incoming.delete(part.n);
      const type = /^image\/(jpeg|png|webp)$/.test(part.type) ? part.type : 'image/jpeg';
      const iv = typeof part.iv === 'string' ? part.iv : null;
      this.on.onPart({ id: String(part.id), kind: part.kind, type, iv, data: new Blob(part.chunks) });
    };
  }

  reset() {
    this.pc?.close();
    this.pc = null;
    this.control = null;
    this.pending = [];
  }
}
