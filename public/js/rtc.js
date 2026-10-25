// WebRTC 点对点传输。照片走加密的 DataChannel（DTLS），服务器只转发建立连接用的信令。
//
// 通道上的消息（按顺序、可靠送达）：
//   { t: 'photo', id, size, type } 后面紧跟若干个二进制分片，合计 size 字节
//   { t: 'show', id, index, total } 展示某张已送达的照片
//   { t: 'viewers', count } 现在有几人在看（含对方自己），和分享者那边显示的人数一致
//   { t: 'end' } 分享结束

const CHUNK = 16 * 1024; // 各浏览器都能稳定收发的分片大小（Safari 的上限比 Chrome 小）
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

export function randomId(bytes = 16) {
  // crypto.randomUUID 只在 HTTPS 下可用，局域网 http 也要能跑
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function linkState(pc) {
  const state = pc.connectionState ?? pc.iceConnectionState;
  return state === 'checking' || state === 'new' ? 'connecting' : state;
}

/** 分享者这一端：每位观看者一条。只在对方需要展示时才发送那一张照片。 */
export class HostLink {
  constructor(peerId, { iceServers, signal, onChange }) {
    this.peerId = peerId;
    this.id = randomId(8); // 区分同一观看者的新旧连接，过期的信令直接丢弃
    this.onChange = onChange;
    this.sent = new Set();
    this.wanted = null;
    this.busy = false;
    this.pending = [];
    this.outbox = Promise.resolve();
    this.inbox = Promise.resolve();
    this.send = (data) => {
      // 信令逐条发送，保证对方按 offer → candidate 的顺序收到
      this.outbox = this.outbox.then(() => signal({ ...data, link: this.id })).catch(() => {});
    };

    const pc = (this.pc = new RTCPeerConnection({ iceServers }));
    // 必须先建通道再 createOffer，否则 SDP 里没有数据通道
    this.channel = pc.createDataChannel('album', { ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = LOW_WATER;
    this.channel.onopen = () => {
      this.onChange(this);
      this.flush();
    };
    this.channel.onclose = () => this.onChange(this);
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
    return this.channel.readyState === 'open';
  }

  get state() {
    return this.open ? 'open' : linkState(this.pc);
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

  /** 让这位观看者看到某张照片；翻得快时只送最新那张。 */
  show(photo, index, total) {
    this.wanted = { photo, index, total };
    this.flush();
  }

  async flush() {
    if (this.busy || !this.open) return;
    this.busy = true;
    try {
      while (this.wanted && this.open) {
        const { photo, index, total } = this.wanted;
        this.wanted = null;
        if (!this.sent.has(photo.id)) {
          await this.sendPhoto(photo);
          this.sent.add(photo.id);
        }
        if (this.wanted) continue; // 传输途中又翻页了，直接跳到最新一张
        this.channel.send(JSON.stringify({ t: 'show', id: photo.id, index, total }));
      }
    } catch {
      // 通道中途断开；重新连上后会建新的 HostLink 重发
    } finally {
      this.busy = false;
    }
  }

  async sendPhoto(photo) {
    const bytes = await photo.blob.arrayBuffer();
    this.channel.send(JSON.stringify({ t: 'photo', id: photo.id, size: bytes.byteLength, type: photo.blob.type }));
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
      if (this.channel.bufferedAmount > HIGH_WATER) await this.drained();
      this.channel.send(bytes.slice(offset, offset + CHUNK));
    }
  }

  drained() {
    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done);
        this.channel.removeEventListener('close', done);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', done);
      this.channel.addEventListener('close', done);
    });
  }

  /** 告诉对方现在有几人在看。按条记住发过的数，换了新连接的观看者即使总数没变也会收到。 */
  setViewers(count) {
    if (!this.open || this.viewers === count) return;
    try {
      this.channel.send(JSON.stringify({ t: 'viewers', count }));
      this.viewers = count;
    } catch {
      // 已断开
    }
  }

  /** 告诉对方分享结束（对方会立即清除照片），然后断开。 */
  end() {
    try {
      if (this.open) this.channel.send(JSON.stringify({ t: 'end' }));
    } catch {
      // 已断开
    }
    setTimeout(() => this.close(), 300);
  }

  close() {
    this.wanted = null;
    this.channel.onclose = null;
    this.pc.close();
  }
}

/** 观看者这一端：接受分享者的连接，收照片和翻页指令。 */
export class ViewerLink {
  constructor({ iceServers, signal, onState, onPhoto, onShow, onViewers, onProgress, onEnd }) {
    this.iceServers = iceServers;
    this.signal = signal;
    this.on = { onState, onPhoto, onShow, onViewers, onProgress, onEnd };
    this.pc = null;
    this.linkId = null;
    this.pending = [];
    this.inbox = Promise.resolve();
    this.outbox = Promise.resolve();
  }

  send(data) {
    const link = this.linkId;
    this.outbox = this.outbox.then(() => this.signal({ ...data, link })).catch(() => {});
  }

  receive(data) {
    this.inbox = this.inbox.then(() => this.process(data)).catch(() => this.on.onState('failed'));
  }

  async process(data) {
    if (data.sdp?.type === 'offer') {
      this.reset();
      this.linkId = data.link;
      const pc = (this.pc = new RTCPeerConnection({ iceServers: this.iceServers }));
      const current = () => pc === this.pc;
      pc.onicecandidate = (e) => e.candidate && current() && this.send({ candidate: e.candidate.toJSON() });
      pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => {
        if (current()) this.on.onState(linkState(pc));
      };
      pc.ondatachannel = (e) => this.attach(e.channel, current);
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

  attach(channel, current) {
    channel.binaryType = 'arraybuffer';
    let incoming = null;
    const opened = () => current() && this.on.onState('open');
    channel.onopen = opened;
    if (channel.readyState === 'open') opened();
    channel.onclose = () => current() && this.on.onState('closed');
    channel.onmessage = ({ data }) => {
      if (!current()) return;
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.t === 'photo') {
          incoming = msg.size > 0 && msg.size <= MAX_PHOTO_BYTES ? { ...msg, chunks: [], received: 0 } : null;
        } else if (msg.t === 'show') {
          this.on.onShow(msg);
        } else if (msg.t === 'viewers') {
          this.on.onViewers(msg.count);
        } else if (msg.t === 'end') {
          this.on.onEnd();
        }
        return;
      }
      if (!incoming) return;
      incoming.chunks.push(data);
      incoming.received += data.byteLength;
      this.on.onProgress(incoming.received / incoming.size);
      if (incoming.received >= incoming.size) {
        const type = /^image\/(jpeg|png|webp)$/.test(incoming.type) ? incoming.type : 'image/jpeg';
        this.on.onPhoto({ id: incoming.id, blob: new Blob(incoming.chunks, { type }) });
        incoming = null;
      }
    };
  }

  reset() {
    this.pc?.close();
    this.pc = null;
    this.pending = [];
  }
}
