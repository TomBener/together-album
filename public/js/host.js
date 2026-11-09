import { $, api, sleep, toast, showView, showNotice, keepScreenOn, copyText, STALL_MS, DEBUG } from './util.js';
import { t, langQuery } from './i18n.js';
import { subscribe } from './live.js';
import { createStage, bindSwipe } from './stage.js';
import { prepareImage, previewOf, largeOf } from './images.js';
import { HostLink, randomId } from './rtc.js';
import { canSeal, newSecret, seal, toBase64 } from './seal.js';
import * as keep from './keep.js';

const MAX_PHOTOS = 100;
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 与服务器一致：一次分享最长 6 小时
const LEAVE_GRACE_MS = 30_000; // 观看者的实时通道断了，等这么久还没回来才放弃对他的连接
const isTouch = matchMedia('(hover: none)').matches;
const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent); // iPad 的 UA 也自称 Macintosh
const inWeChat = /MicroMessenger/i.test(navigator.userAgent);

// 照片经 WebRTC 加密发给观看者，从不上传服务器。分享期间暂存在本机浏览器里（keep.js），
// 分享页被关掉或刷新后再打开，能接着分享
const S = {
  id: null,
  key: null,
  createdAt: 0,
  iceServers: [],
  items: [], // 缩略条里的每一张：{ el, img, ready, id, index, blob, url, thumbUrl, secret, payload }
  photos: [], // 已准备好的照片，按顺序
  index: -1,
  links: new Map(), // 观看者 peerId → HostLink
  met: new Set(), // 连上过的观看者。都断开时显示“朋友暂时离开”，而不是“等待朋友加入”
  joinUrls: [],
  urlChoice: 0,
  conn: 'connecting',
  live: null,
  failed: 0,
  resuming: null, // 重新打开分享页后、照片还没取回时：{ index, total }
  ended: false,
};

let stage;
let creating = false;
const unsaved = []; // 分享还没建好时就处理完的照片：[item, 各版本]，建好后再暂存
// 加密好、准备发给观看者的数据，几位观看者共用。只留最近用到的几份：iPhone 上页面内存紧，
// 每张照片都留一份的话，翻完 100 张要多占约 100 MB。用到被丢掉的那份时重新加密，几毫秒
const PAYLOAD_KEEP = 12;
const payloads = new Map(); // '照片id:版本' → Promise<{ bytes, type, iv }>
let prepareChain = Promise.resolve(); // 逐张压缩，顺序与选择顺序一致
let inviteSignature = '';
let openBefore = 0;
const stallHinted = new Set(); // 已经提示过“连不上”的观看者，每人只提示一次
const leaving = new Map(); // 实时通道断开的观看者 peerId → 放弃连接的计时器

export function startHost() {
  document.body.classList.add('role-host');
  stage = createStage($('#stage'));
  bindControls();

  const ending = keep.pendingEnd();
  if (ending) endOnServer(ending); // 上次点了结束，但没通知到服务器
  const saved = keep.loadSession();
  if (saved && saved.id !== ending?.id) {
    resume(saved);
  } else {
    keep.forget(); // 清掉可能残留的照片
    showView('landing');
  }
}

// ---- 会话 ----

// 分享页被关掉或刷新后重新打开：会话还在就接着分享，发出去的链接照常有效
async function resume(saved) {
  showView('stage');
  $('#placeholder-text').textContent = t('resuming');
  let status = null;
  if (Date.now() - saved.createdAt < MAX_AGE_MS) {
    try {
      status = await api(`/api/sessions/${saved.id}`, { key: saved.key });
    } catch (err) {
      if (err.status !== 404) status = {}; // 网络不好：先接着分享，实时通道连上后再取回照片
    }
  }
  if (!status) {
    keep.forget();
    showView('landing');
    toast(t('lastShareEnded'));
    return;
  }
  S.resuming = { index: saved.index ?? 0, total: saved.total ?? 0 };
  begin({ id: saved.id, hostKey: saved.key, joinUrls: saved.joinUrls ?? [], ice: [] }, saved.createdAt);
  if (status.keepKey) restorePhotos(status.keepKey);
}

// 用服务器给的钥匙解开暂存的照片，回到关掉前看的那张
async function restorePhotos(keepKey) {
  const pending = S.resuming;
  if (!pending || pending.started) return;
  pending.started = true;
  keep.useKey(keepKey);
  const photos = await keep.loadPhotos(S.id);
  if (S.ended) return;
  for (const p of photos) markReady(addItem(), p, { restored: true });
  S.resuming = null; // 取回之后才能添加新照片，新照片接在后面
  if (S.photos.length) setIndex(Math.min(Math.max(pending.index, 0), S.photos.length - 1));
  remember();
  render();
  const missing = pending.total - S.photos.length;
  toast(missing > 0 ? t('resumedMissing', missing) : t('resumed'), missing > 0 ? 6000 : 2600);
}

async function onPick() {
  const picker = $('#picker');
  const files = [...picker.files];
  picker.value = '';
  if (!files.length || S.ended) return;
  if (S.resuming) {
    toast(t('resuming')); // 先等暂存的照片取回来，新照片排在它们后面
    return;
  }
  if (!S.id && !creating) createSession(); // 不等服务器：照片马上显示、开始处理，分享同时在建
  addFiles(files);
}

async function createSession() {
  creating = true;
  showView('stage');
  render();
  try {
    begin(await postSession());
    openInvite();
  } catch {
    toast(t('networkLater'));
    abandon();
  } finally {
    creating = false;
  }
}

// 网络出错或服务器出错时重试两次；请求太频繁（429）等其他错误不重试
async function postSession() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api('/api/sessions', { method: 'POST' });
    } catch (err) {
      if (attempt >= 2 || (err.status && err.status < 500)) throw err;
      await sleep(600 * 2 ** attempt);
    }
  }
}

// 分享没建成：回到首页，丢掉刚选的照片
function abandon() {
  for (const item of S.items) {
    item.el.remove();
    for (const url of [item.thumbUrl, item.url]) if (url) URL.revokeObjectURL(url);
  }
  S.items = [];
  S.photos = [];
  S.index = -1;
  unsaved.length = 0;
  payloads.clear();
  stage.clear();
  showView('landing');
}

function begin(session, createdAt = Date.now()) {
  S.id = session.id;
  S.key = session.hostKey;
  S.createdAt = createdAt;
  S.iceServers = session.ice;
  S.joinUrls = session.joinUrls;
  if (session.keepKey) keep.useKey(session.keepKey);
  for (const [item, parts] of unsaved.splice(0)) keep.savePhoto(S.id, item.index, parts);
  remember();
  showView('stage');
  holdLock();
  // 关掉或刷新页面不结束分享：观看者那边显示“对方暂时离开”，回来后接着分享。
  // 不回来的话，服务器在分享者离开 1 小时后结束分享
  S.live = subscribe(`/api/sessions/${S.id}/live?key=${S.key}`, `/api/sessions/${S.id}`, {
    onMessage,
    onStatus: (conn) => {
      S.conn = conn;
      render();
    },
    onGone: () => finish('gone'),
  });
  keepScreenOn();
  render();
}

// 记下会话，分享页被关掉后重新打开时用。照片还没取回时不记，免得盖掉上次看到第几张
function remember() {
  if (S.ended || S.resuming || !S.id) return;
  keep.saveSession({
    id: S.id,
    key: S.key,
    createdAt: S.createdAt,
    joinUrls: S.joinUrls,
    index: S.index,
    total: S.items.length,
  });
}

// 同一个分享只让一个页面进行：在另一个页面里重新打开时，由新页面接手，这个页面停下
function holdLock() {
  navigator.locks
    ?.request(`together-album:host:${S.id}`, { steal: true }, () => new Promise(() => {}))
    .catch(() => handOff());
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello': // 首次连上或重连：对齐观看者名单。重新打开的分享页从这里拿到连接配置
      S.joinUrls = msg.joinUrls;
      if (msg.ice) S.iceServers = msg.ice;
      if (S.resuming) restorePhotos(msg.keepKey); // 没有钥匙（旧会话）时取不回照片，提示分享者重新添加
      remember();
      for (const [peerId, link] of S.links) if (!msg.peers.includes(peerId) && !link.open) leaveLater(peerId);
      for (const peerId of msg.peers) ensurePeer(peerId);
      break;
    case 'peer-join':
      ensurePeer(msg.peerId);
      break;
    case 'ice': // 服务器后来才领到中转凭证：之后新建的连接用上它
      S.iceServers = msg.ice;
      break;
    case 'peer-leave':
      // 只是信令断了的话，直连可能还在，或者还在建立，照常使用；直连断开时通道会自己关闭
      if (!S.links.get(msg.peerId)?.open) leaveLater(msg.peerId);
      break;
    case 'signal':
      if (msg.data.reconnect) {
        // 观看者那边一直没连上，请求重来。只认针对当前这条连接的请求，旧请求晚到时不打断新连接
        const link = S.links.get(msg.from);
        if (!link || link.stale || !msg.data.link || msg.data.link === link.id) connectPeer(msg.from);
      } else {
        S.links.get(msg.from)?.receive(msg.data);
      }
      break;
    case 'ended':
      return finish(msg.reason === 'host' ? 'self' : 'expired');
  }
  render();
}

// 观看者（重新）连上信令：已有的连接还在正常建立就不打断，失败了或拖太久才重来
function ensurePeer(peerId) {
  clearTimeout(leaving.get(peerId));
  leaving.delete(peerId);
  const link = S.links.get(peerId);
  if (!link || link.stale) connectPeer(peerId);
}

// 观看者的信令断了：常常几秒后就重连回来，先等一等再放弃对他的连接
function leaveLater(peerId) {
  if (leaving.has(peerId)) return;
  const timer = setTimeout(() => {
    leaving.delete(peerId);
    if (!S.links.get(peerId)?.open) dropLink(peerId);
    render();
  }, LEAVE_GRACE_MS);
  leaving.set(peerId, timer);
}

function connectPeer(peerId) {
  S.links.get(peerId)?.close();
  const link = new HostLink(peerId, {
    iceServers: S.iceServers,
    signal: (data) => api(`/api/sessions/${S.id}/signal`, { method: 'POST', key: S.key, json: { to: peerId, data } }),
    onChange: render,
  });
  S.links.set(peerId, link);
  link.focus(S.photos, S.index);
  setTimeout(() => {
    if (S.ended || S.links.get(peerId) !== link || link.open || stallHinted.has(peerId)) return;
    stallHinted.add(peerId);
    toast(t('connectHint'), 8000);
  }, STALL_MS);
}

function dropLink(peerId) {
  S.links.get(peerId)?.close();
  S.links.delete(peerId);
}

// 点“结束”后立即清屏：已连上的朋友经数据通道马上收到“结束”，服务器在后台通知其余的人、让链接失效
function endSession() {
  $('#confirm-end').close();
  const session = { id: S.id, key: S.key };
  keep.markEnding(session);
  finish('self');
  endOnServer(session);
}

async function endOnServer({ id, key }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE', key, keepalive: true });
    } catch (err) {
      if (err.status !== 404 && err.status !== 401) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
    }
    keep.clearEnding();
    return;
  }
  // 一直没通知到服务器：留着记录，下次打开页面时再发
}

// 停下这个页面：关掉连接、清掉照片
function teardown(sayEnd) {
  S.ended = true;
  for (const link of S.links.values()) {
    if (sayEnd) link.end();
    else link.close();
  }
  S.links.clear();
  for (const timer of leaving.values()) clearTimeout(timer);
  leaving.clear();
  S.live?.close();
  stage.clear();
  for (const item of S.items) {
    item.el.remove();
    for (const url of [item.thumbUrl, item.url]) if (url) URL.revokeObjectURL(url);
  }
  S.items = [];
  S.photos = [];
  unsaved.length = 0;
  payloads.clear();
}

// 分享在另一个页面里接着进行了：这里停下，但不结束分享，也不删暂存的照片
function handOff() {
  if (S.ended) return;
  teardown(false);
  showNotice({ title: t('handedOff'), text: t('handedOffText') });
}

function finish(reason) {
  if (S.ended) return;
  teardown(true);
  keep.forget();
  const text = {
    self: t('endedSelf'),
    expired: t('endedExpired'),
    gone: t('endedGone'),
  }[reason];
  showNotice({ title: t('shareEnded'), text, action: { label: t('shareAgain'), href: `/${langQuery}` } });
}

// ---- 照片 ----

function addFiles(files) {
  const room = MAX_PHOTOS - S.items.length;
  if (files.length > room) {
    toast(t('tooMany', MAX_PHOTOS, files.length - room));
    files = files.slice(0, Math.max(0, room));
  }
  const items = files.map(() => addItem());
  remember(); // 记下一共选了几张，重新打开时能告诉分享者有几张没来得及处理
  for (const [i, file] of files.entries()) {
    const item = items[i];
    prepareChain = prepareChain.then(async () => {
      const dropped = () => S.ended || !S.items.includes(item); // 分享结束了，或者分享没建成、照片已丢掉
      if (dropped()) return;
      try {
        const parts = await prepareImage(file);
        if (dropped()) return;
        markReady(item, { ...parts, file });
      } catch {
        if (!dropped()) dropItem(item);
      }
    });
  }
  render();
}

function addItem() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'thumb is-pending';
  el.setAttribute('aria-label', t('preparingThumb'));
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  el.append(img);
  const item = { el, img, ready: false, id: null, index: -1, blob: null, url: null, thumbUrl: null, secret: null, payload: null };
  el.addEventListener('click', () => item.ready && go(item.index));
  $('#strip').insertBefore(el, $('#strip .thumb-add'));
  S.items.push(item);
  return item;
}

// parts：{ full, preview, thumb }，加上刚选的照片的原图 file、原画质的长边 fullEdge、值不值得做大一档（large）。
// 恢复的照片还带着原来的 id（旧版本存的没有 id 和 preview），没有原图，也就没有大一档的
function markReady(item, { id, full, preview, thumb, file, fullEdge, large }, { restored = false } = {}) {
  item.index = S.photos.push(item) - 1;
  // 每张照片一把钥匙：提前发给观看者的数据用它锁上，分享者翻到这张时才把钥匙发过去。
  // 钥匙只在这个页面的内存里，不暂存；重新打开分享页时换新钥匙
  const secret = canSeal ? newSecret() : null;
  // 发给观看者的数据：preview 是先发的小图，full 是原画质，large 是给大屏幕的大一档
  const source = (kind) => (kind === 'large' ? largeOf(file) : kind === 'full' ? full : (preview ?? previewOf(full)));
  Object.assign(item, {
    ready: true,
    id: id ?? randomId(6),
    blob: full,
    url: URL.createObjectURL(full),
    thumbUrl: URL.createObjectURL(thumb),
    secret: secret && toBase64(secret),
    fullEdge: fullEdge ?? 2048,
    large: Boolean(file && large),
    payload: (kind) => payloadOf(`${item.id}:${kind}`, () => encodePart(source(kind), secret)),
  });
  item.img.src = item.thumbUrl;
  item.el.classList.remove('is-pending');
  item.el.setAttribute('aria-label', t('photoN', item.index + 1));
  if (restored) return; // 恢复时由 resume 统一决定展示哪张
  const parts = { id: item.id, full, preview, thumb };
  if (S.id) keep.savePhoto(S.id, item.index, parts);
  else unsaved.push([item, parts]);
  if (S.index === -1) setIndex(0); // 第一张好了就直接展示，朋友扫码即可看到
  else broadcast(); // 总张数变了
  render();
}

function payloadOf(key, make) {
  let payload = payloads.get(key);
  if (payload) payloads.delete(key); // 放到最后，算最近用过
  else payload = make();
  payloads.set(key, payload);
  while (payloads.size > PAYLOAD_KEEP) payloads.delete(payloads.keys().next().value);
  return payload;
}

async function encodePart(source, secret) {
  const blob = await source;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!secret) return { bytes, type: blob.type };
  const { iv, data } = await seal(secret, bytes);
  return { bytes: data, type: blob.type, iv: toBase64(iv) };
}

function dropItem(item) {
  item.el.remove();
  S.items.splice(S.items.indexOf(item), 1);
  S.failed++;
  toast(t('unreadable', S.failed));
  remember();
  render();
}

// ---- 翻页 ----

function go(index) {
  if (S.ended || index === S.index || index < 0) return;
  if (index >= S.photos.length) {
    if (S.photos.length) toast(t(S.items.some((i) => !i.ready) ? 'nextPreparing' : 'lastPhoto'));
    return;
  }
  setIndex(index);
}

function setIndex(index) {
  const direction = S.index === -1 ? 0 : Math.sign(index - S.index);
  S.photos[S.index]?.el.classList.remove('is-current');
  S.index = index;
  const item = S.photos[index];
  item.el.classList.add('is-current');
  // 不用 scrollIntoView：它会连带滚动 overflow:hidden 的舞台，把顶栏挤出屏幕
  const strip = $('#strip');
  strip.scrollTo({ left: item.el.offsetLeft - (strip.clientWidth - item.el.offsetWidth) / 2, behavior: 'smooth' });
  stage.show(item.url, direction);
  broadcast();
  remember();
  render();
}

// 告诉每位观看者翻到了哪张。连接按先后发当前这张和前后几张，前后几张是锁着的，翻到时才发钥匙
function broadcast() {
  if (S.index < 0) return;
  for (const link of S.links.values()) link.focus(S.photos, S.index);
}

// ---- 界面 ----

function render() {
  if (S.ended) return;
  const links = [...S.links.values()];
  // 只算正在看的：页面切到后台或网络中断的朋友算暂时离开
  const present = links.filter((l) => l.present).length;
  // 连着的（含暂时离开的），只用来判断有没有新朋友加入：朋友从后台回来时不再提示一遍
  const joined = links.filter((l) => l.open).length;
  for (const link of links) link.setViewers(present);
  // 还没连上过、也没失败的都算在连：网络层已连通、通道还差一步时也是。连上过又断开的算暂时离开
  const connecting = links.filter((l) => !l.wasOpen && l.state !== 'failed' && l.state !== 'closed').length;

  let state = 'live';
  let text = t('watching', present);
  for (const [peerId, link] of S.links) if (link.wasOpen) S.met.add(peerId);
  // 排查时标出有人经中转连上（网址带 ?debug=1）
  if (DEBUG && links.some((l) => l.present && l.relayed)) text += ` · ${t('relayed')}`;
  if (!present) {
    if (S.conn !== 'live') [state, text] = ['warn', t(S.conn === 'connecting' ? 'connecting' : 'reconnecting')];
    else if (connecting) [state, text] = ['wait', t('friendConnecting')];
    else if (S.met.size) [state, text] = ['wait', t('friendAway')];
    else [state, text] = ['wait', t('waitingFriends')];
  }
  $('#status').dataset.state = state;
  $('#status .chip-text').textContent = text;

  if (joined > openBefore) {
    if ($('#invite').open) $('#invite').close();
    if (openBefore === 0) toast(t(isTouch ? 'friendJoinedTouch' : 'friendJoinedMouse'));
    else toast(t('joined', present));
  }
  openBefore = joined;

  const pending = S.items.filter((i) => !i.ready).length;
  const parts = [];
  if (S.photos.length) parts.push(`${S.index + 1} / ${S.photos.length}`);
  if (pending) parts.push(t('preparingCount', pending));
  $('#counter').textContent = parts.join(' · ');

  $('#placeholder').hidden = S.index >= 0;
  $('#placeholder-text').textContent = t(S.resuming ? 'resuming' : S.items.length ? 'preparingPhotos' : 'pickToContinue');
  $('#btn-prev').disabled = S.index <= 0;
  $('#btn-next').disabled = S.index >= S.photos.length - 1;
  // 分享还在建：还没有链接可邀请，也没有分享可结束
  $('#btn-invite').disabled = $('#btn-end').disabled = !S.id;

  if ($('#invite').open) renderInvite();
}

function openInvite() {
  inviteSignature = '';
  renderInvite();
  if (!$('#invite').open) $('#invite').showModal();
}

function renderInvite() {
  const choice = Math.min(S.urlChoice, S.joinUrls.length - 1);
  const join = S.joinUrls[choice];
  const signature = `${choice}|${S.joinUrls.map((j) => j.url).join(' ')}`;
  if (signature !== inviteSignature) {
    inviteSignature = signature;
    $('#qr').src = `/api/sessions/${S.id}/qr?u=${choice}`;
    $('#join-link').value = join?.url ?? '';
    // 系统分享面板：iPhone 上可以直接隔空投送给旁边的朋友，安卓上是快速分享。只在 HTTPS 下可用
    $('#btn-share').hidden = !join || !navigator.share || navigator.canShare?.({ url: join.url }) === false;
    const seg = $('#addr-switch');
    seg.hidden = S.joinUrls.length < 2;
    seg.replaceChildren(
      ...S.joinUrls.map((j, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = addressLabel(j);
        button.setAttribute('aria-pressed', String(i === choice));
        button.addEventListener('click', () => {
          S.urlChoice = i;
          renderInvite();
        });
        return button;
      }),
    );
    // 在微信里分享的人发链接时要离开这个页面，提示他回来接着翻
    $('#invite-hint').textContent = t(
      join?.kind === 'public'
        ? inWeChat
          ? 'hintWeChat'
          : 'hintPublic'
        : join?.kind === 'tailscale'
          ? 'hintTailscale'
          : 'hintLan',
    );
  }

  const total = S.items.length;
  const done = S.photos.length;
  $('#upload').hidden = total === 0 || done === total;
  $('#upload-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#upload-text').textContent = t('processing', done, total);
}

// 公网、当前地址、本机这几种按界面语言显示；网卡名（Wi‑Fi、Ethernet）和 Tailscale 原样显示
function addressLabel(join) {
  const key = { public: 'addrPublic', current: 'addrCurrent', local: 'addrLocal' }[join.kind];
  return key ? t(key) : join.label;
}

function bindControls() {
  $('#picker').addEventListener('change', onPick);
  $('#btn-prev').addEventListener('click', () => go(S.index - 1));
  $('#btn-next').addEventListener('click', () => go(S.index + 1));
  $('#btn-invite').addEventListener('click', openInvite);
  $('#btn-start').addEventListener('click', () => {
    $('#invite').close();
    if (isTouch && openBefore === 0) toast(t('swipeHint'));
  });
  $('#share-text').textContent = t(isApple ? 'airdrop' : 'sendLink');
  $('#btn-share').addEventListener('click', async () => {
    try {
      // 只传链接：带上文字的话，隔空投送会把它当成一段备忘而不是直接打开网页
      await navigator.share({ url: $('#join-link').value });
    } catch (err) {
      if (err.name !== 'AbortError') toast(t('shareFailed'));
    }
  });
  $('#btn-copy').addEventListener('click', async () => {
    const ok = await copyText($('#join-link').value, $('#join-link'));
    toast(t(ok ? 'copied' : 'copyFailed'));
  });
  $('#btn-end').addEventListener('click', () => $('#confirm-end').showModal());
  $('#confirm-cancel').addEventListener('click', () => $('#confirm-end').close());
  $('#confirm-ok').addEventListener('click', endSession);

  // 点弹层外面关闭
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      // 点在里面的按钮上不算；键盘或读屏触发的点击没有坐标，不能只靠位置判断
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dialog.close();
    });
  }

  document.addEventListener('keydown', (e) => {
    if ($('#stage').hidden || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      go(S.index + step);
    } else if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      go(S.index + 1);
    } else if (e.key === 'Home') {
      go(0);
    } else if (e.key === 'End') {
      go(S.photos.length - 1);
    }
  });

  // 切到别的 App、锁屏或关掉页面时马上告诉观看者，他们那边显示“对方暂时离开”
  const here = () => {
    const on = document.visibilityState === 'visible';
    for (const link of S.links.values()) link.sendHere(on);
  };
  document.addEventListener('visibilitychange', here);
  window.addEventListener('pagehide', () => {
    for (const link of S.links.values()) link.sendHere(false);
  });

  // 滑动翻页；点按左右三分之一处也能翻
  bindSwipe(stage, {
    canStep: (step) => S.index >= 0 && Boolean(S.photos[S.index + step]),
    step: (step) => go(S.index + step),
    blocked: (step) => go(S.index + step), // 由 go 提示“已经是最后一张了”等
    tap(x) {
      if (x < 0.3) go(S.index - 1);
      else if (x > 0.7) go(S.index + 1);
    },
  });
}
