import { $, api, toast, showView, showNotice, keepScreenOn, copyText, STALL_MS, CONNECT_HINT } from './util.js';
import { subscribe } from './live.js';
import { createStage, bindSwipe } from './stage.js';
import { prepareImage } from './images.js';
import { HostLink } from './rtc.js';

const STORE_KEY = 'together-album:host';
const MAX_PHOTOS = 100;
const isTouch = matchMedia('(hover: none)').matches;
const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent); // iPad 的 UA 也自称 Macintosh

// 照片只存在于这个页面的内存里，直接经 WebRTC 发给观看者，从不上传服务器
const S = {
  id: null,
  key: null,
  iceServers: [],
  items: [], // 缩略条里的每一张：{ el, img, ready, id, index, blob, url, thumbUrl }
  photos: [], // 已准备好的照片，按顺序
  index: -1,
  links: new Map(), // 观看者 peerId → HostLink
  joinUrls: [],
  urlChoice: 0,
  conn: 'connecting',
  live: null,
  failed: 0,
  ended: false,
};

let stage;
let creating = false;
let prepareChain = Promise.resolve(); // 逐张压缩，顺序与选择顺序一致
let inviteSignature = '';
let openBefore = 0;
const stallHinted = new Set(); // 已经提示过“连不上”的观看者，每人只提示一次

export function startHost() {
  document.body.classList.add('role-host');
  stage = createStage($('#stage'));
  bindControls();
  showView('landing');

  // 刷新后照片已不在内存里，上一次分享随之结束
  const saved = readSaved();
  if (saved) {
    sessionStorage.removeItem(STORE_KEY);
    api(`/api/sessions/${saved.id}`, { method: 'DELETE', key: saved.key }).catch(() => {});
    toast('页面刷新后，上一次分享已结束');
  }
}

function readSaved() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY));
  } catch {
    return null;
  }
}

// ---- 会话 ----

async function onPick() {
  const picker = $('#picker');
  const files = [...picker.files];
  picker.value = '';
  if (!files.length || S.ended) return;
  if (!S.id) {
    if (creating) return;
    creating = true;
    try {
      begin(await api('/api/sessions', { method: 'POST' }));
    } catch {
      toast('网络不太好，请稍后再试');
      return;
    } finally {
      creating = false;
    }
    openInvite();
  }
  addFiles(files);
}

function begin(session) {
  S.id = session.id;
  S.key = session.hostKey;
  S.iceServers = session.ice;
  S.joinUrls = session.joinUrls;
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ id: S.id, key: S.key }));
  showView('stage');
  S.live = subscribe(`/api/sessions/${S.id}/live?key=${S.key}`, `/api/sessions/${S.id}`, {
    onMessage,
    onStatus: (conn) => {
      S.conn = conn;
      render();
    },
    onGone: () => finish('gone'),
  });
  // 关闭或刷新页面时结束会话，朋友那边立即清屏
  addEventListener('pagehide', () => {
    if (S.ended) return;
    fetch(`/api/sessions/${S.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${S.key}` }, keepalive: true });
  });
  keepScreenOn();
  render();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello': // 首次连上或重连：对齐观看者名单
      S.joinUrls = msg.joinUrls;
      for (const [peerId, link] of S.links) if (!msg.peers.includes(peerId) && !link.open) dropLink(peerId);
      for (const peerId of msg.peers) if (!S.links.get(peerId)?.open) connectPeer(peerId);
      break;
    case 'peer-join':
      if (!S.links.get(msg.peerId)?.open) connectPeer(msg.peerId);
      break;
    case 'peer-leave':
      // 只是信令断了的话直连可能还在，照常使用；直连断开时通道会自己关闭
      if (!S.links.get(msg.peerId)?.open) dropLink(msg.peerId);
      break;
    case 'signal':
      if (msg.data.reconnect) connectPeer(msg.from);
      else S.links.get(msg.from)?.receive(msg.data);
      break;
    case 'ended':
      return finish(msg.reason === 'host' ? 'self' : 'expired');
  }
  render();
}

function connectPeer(peerId) {
  S.links.get(peerId)?.close();
  const link = new HostLink(peerId, {
    iceServers: S.iceServers,
    signal: (data) => api(`/api/sessions/${S.id}/signal`, { method: 'POST', key: S.key, json: { to: peerId, data } }),
    onChange: render,
  });
  S.links.set(peerId, link);
  if (S.index >= 0) link.show(S.photos[S.index], S.index, S.photos.length);
  setTimeout(() => {
    if (S.ended || S.links.get(peerId) !== link || link.open || stallHinted.has(peerId)) return;
    stallHinted.add(peerId);
    toast(CONNECT_HINT, 8000);
  }, STALL_MS);
}

function dropLink(peerId) {
  S.links.get(peerId)?.close();
  S.links.delete(peerId);
}

async function endSession() {
  const button = $('#confirm-ok');
  button.disabled = true;
  try {
    await api(`/api/sessions/${S.id}`, { method: 'DELETE', key: S.key });
  } catch (err) {
    if (err.status !== 404) {
      button.disabled = false;
      toast('网络不太好，请重试');
      return;
    }
  }
  finish('self');
}

function finish(reason) {
  if (S.ended) return;
  S.ended = true;
  for (const link of S.links.values()) link.end();
  S.links.clear();
  S.live?.close();
  sessionStorage.removeItem(STORE_KEY);
  stage.clear();
  for (const item of S.items) {
    item.el.remove();
    for (const url of [item.thumbUrl, item.url]) if (url) URL.revokeObjectURL(url);
  }
  S.items = [];
  S.photos = [];
  const text = {
    self: '朋友屏幕上的照片已经清除，链接也已失效。',
    expired: '分享时间过长或离开太久，已自动结束。',
    gone: '这次分享已经结束，朋友屏幕上的照片已经清除。',
  }[reason];
  showNotice({ title: '分享已结束', text, action: { label: '再分享一组', href: '/' } });
}

// ---- 照片 ----

function addFiles(files) {
  const room = MAX_PHOTOS - S.items.length;
  if (files.length > room) {
    toast(`一次最多分享 ${MAX_PHOTOS} 张，多出的 ${files.length - room} 张没有加入`);
    files = files.slice(0, Math.max(0, room));
  }
  for (const file of files) {
    const item = addItem();
    prepareChain = prepareChain.then(async () => {
      if (S.ended) return;
      try {
        const { full, thumb } = await prepareImage(file);
        if (S.ended) return;
        markReady(item, full, thumb);
      } catch {
        dropItem(item);
      }
    });
  }
  render();
}

function addItem() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'thumb is-pending';
  el.setAttribute('aria-label', '正在准备');
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  el.append(img);
  const item = { el, img, ready: false, id: null, index: -1, blob: null, url: null, thumbUrl: null };
  el.addEventListener('click', () => item.ready && go(item.index));
  $('#strip').insertBefore(el, $('#strip .thumb-add'));
  S.items.push(item);
  return item;
}

function markReady(item, full, thumb) {
  item.index = S.photos.push(item) - 1;
  Object.assign(item, {
    ready: true,
    id: String(item.index),
    blob: full,
    url: URL.createObjectURL(full),
    thumbUrl: URL.createObjectURL(thumb),
  });
  item.img.src = item.thumbUrl;
  item.el.classList.remove('is-pending');
  item.el.setAttribute('aria-label', `第 ${item.index + 1} 张`);
  if (S.index === -1) setIndex(0); // 第一张好了就直接展示，朋友扫码即可看到
  else broadcast(); // 总张数变了
  render();
}

function dropItem(item) {
  item.el.remove();
  S.items.splice(S.items.indexOf(item), 1);
  S.failed++;
  toast(`有 ${S.failed} 张照片无法读取，已跳过`);
  render();
}

// ---- 翻页 ----

function go(index) {
  if (S.ended || index === S.index || index < 0) return;
  if (index >= S.photos.length) {
    if (S.photos.length) toast(S.items.some((i) => !i.ready) ? '后面的照片还在准备中' : '已经是最后一张了');
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
  render();
}

// 只把当前这一张发给观看者；没翻到的照片不会离开这台设备
function broadcast() {
  if (S.index < 0) return;
  for (const link of S.links.values()) link.show(S.photos[S.index], S.index, S.photos.length);
}

// ---- 界面 ----

function render() {
  if (S.ended) return;
  const links = [...S.links.values()];
  const open = links.filter((l) => l.open).length;
  const connecting = links.filter((l) => l.state === 'connecting' || l.state === 'new').length;

  let state = 'live';
  let text = `${open} 人在看`;
  if (!open) {
    if (S.conn !== 'live') [state, text] = ['warn', S.conn === 'connecting' ? '正在连接…' : '连接中断，正在重连…'];
    else if (connecting) [state, text] = ['wait', '朋友正在连接…'];
    else [state, text] = ['wait', '等待朋友加入'];
  }
  $('#status').dataset.state = state;
  $('#status .chip-text').textContent = text;

  if (open > openBefore) {
    if ($('#invite').open) $('#invite').close();
    if (openBefore === 0) toast(isTouch ? '朋友已连上 · 左右滑动翻页' : '朋友已连上，用方向键或点两侧翻页');
    else toast(`又有人加入了，现在 ${open} 人在看`);
  }
  openBefore = open;

  const pending = S.items.filter((i) => !i.ready).length;
  const parts = [];
  if (S.photos.length) parts.push(`${S.index + 1} / ${S.photos.length}`);
  if (pending) parts.push(`正在准备 ${pending} 张`);
  $('#counter').textContent = parts.join(' · ');

  $('#placeholder').hidden = S.index >= 0;
  $('#placeholder-text').textContent = '正在准备照片…';
  $('#btn-prev').disabled = S.index <= 0;
  $('#btn-next').disabled = S.index >= S.photos.length - 1;

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
        button.textContent = j.label;
        button.setAttribute('aria-pressed', String(i === choice));
        button.addEventListener('click', () => {
          S.urlChoice = i;
          renderInvite();
        });
        return button;
      }),
    );
    $('#invite-hint').textContent =
      join?.label === '公网'
        ? '开着 VPN 的话请先关掉；在一起时连同一个 Wi‑Fi 最流畅。'
        : join?.label === 'Tailscale'
          ? '这是 Tailscale 地址，只有登录了你的 Tailscale 的设备能打开。'
          : '朋友需要和你连同一个 Wi‑Fi。打不开的话换个地址，或用 npm run tunnel 启动公网模式。';
  }

  const total = S.items.length;
  const done = S.photos.length;
  $('#upload').hidden = total === 0 || done === total;
  $('#upload-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#upload-text').textContent = `正在处理照片 ${done} / ${total}`;
}

function bindControls() {
  $('#picker').addEventListener('change', onPick);
  $('#btn-prev').addEventListener('click', () => go(S.index - 1));
  $('#btn-next').addEventListener('click', () => go(S.index + 1));
  $('#btn-invite').addEventListener('click', openInvite);
  $('#btn-start').addEventListener('click', () => {
    $('#invite').close();
    if (isTouch && openBefore === 0) toast('左右滑动，或点按屏幕两侧翻页');
  });
  $('#share-text').textContent = isApple ? '用隔空投送发给朋友' : '发送链接';
  $('#btn-share').addEventListener('click', async () => {
    try {
      // 只传链接：带上文字的话，隔空投送会把它当成一段备忘而不是直接打开网页
      await navigator.share({ url: $('#join-link').value });
    } catch (err) {
      if (err.name !== 'AbortError') toast('没能打开分享，请复制链接发给朋友');
    }
  });
  $('#btn-copy').addEventListener('click', async () => {
    const ok = await copyText($('#join-link').value, $('#join-link'));
    toast(ok ? '链接已复制' : '复制失败，请长按链接手动复制');
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
