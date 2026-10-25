import { $, api, toast, showView, showNotice, keepScreenOn, STALL_MS, CONNECT_HINT } from './util.js';
import { subscribe } from './live.js';
import { createStage, bindSwipe } from './stage.js';
import { ViewerLink, randomId } from './rtc.js';

const RETRY_MS = 12_000; // 这么久还没连上，就请分享者重新发起连接
const isTouch = matchMedia('(hover: none)').matches;

export function startViewer(sessionId) {
  document.body.classList.add('role-viewer');
  showView('stage');
  const stageEl = $('#stage');
  const stage = createStage(stageEl);
  const peerId = randomId(); // 整个页面生命周期不变，信令断线重连不会被当成新观看者
  const photos = new Map(); // 照片 id → blob URL
  // 第几张 → 照片 id。只记分享者翻到并停留过的照片，观看者只能在这些照片里来回翻；
  // 快速连翻时传到一半就被跳过的照片不在其中
  const seen = new Map();
  const V = {
    link: null,
    p2p: 'idle',
    signaling: 'connecting',
    failures: 0,
    progress: null,
    index: -1, // 这台设备正在看的
    host: -1, // 分享者正在看的
    total: 0,
    viewers: 0, // 几人在看，由分享者告知
    peak: 0, // 这次分享里最多同时几人在看
    following: true, // 跟着分享者翻；自己翻到别处后为 false，直到回到分享者那一张
    hinted: false,
    stalled: false, // 连了一阵还没连上，改为显示怎么解决
    ended: false,
  };
  let retryTimer = null;
  let stallTimer = null;
  let idleTimer = null;

  const signal = (data) =>
    api(`/api/sessions/${sessionId}/signal`, { method: 'POST', json: { peer: peerId, data } });

  const live = subscribe(`/api/sessions/${sessionId}/live?peer=${peerId}`, `/api/sessions/${sessionId}`, {
    onMessage(msg) {
      if (msg.type === 'welcome') {
        V.link ??= new ViewerLink({
          iceServers: msg.ice,
          signal,
          onState,
          onPhoto,
          onShow,
          onViewers,
          onProgress,
          onEnd: () => end('ended'),
        });
        if (V.p2p !== 'open') retryLater(RETRY_MS);
        stallTimer ??= setTimeout(() => {
          V.stalled = true;
          render();
        }, STALL_MS);
      } else if (msg.type === 'signal') {
        V.link?.receive(msg.data);
      } else if (msg.type === 'ended') {
        end('ended');
      }
      render();
    },
    onStatus(state) {
      V.signaling = state;
      render();
    },
    onGone: () => end(V.index >= 0 ? 'ended' : 'gone'),
  });

  function retryLater(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (V.ended || V.p2p === 'open') return;
      signal({ reconnect: true }).catch(() => {});
      retryLater(RETRY_MS);
    }, ms);
  }

  function onState(state) {
    V.p2p = state;
    if (state === 'open') {
      clearTimeout(retryTimer);
      V.failures = 0;
    } else if (state === 'failed' || state === 'closed') {
      V.failures++;
      V.progress = null;
      retryLater(2000);
    } else if (state === 'disconnected') {
      retryLater(RETRY_MS); // 往往能自己恢复，先等一等
    }
    render();
  }

  function onProgress(fraction) {
    V.progress = fraction;
    render();
  }

  function onPhoto({ id, blob }) {
    if (V.ended) return;
    URL.revokeObjectURL(photos.get(id) ?? '');
    photos.set(id, URL.createObjectURL(blob));
    V.progress = null;
    render();
  }

  // 分享者翻页、加照片或重连时都会发来；张数变了但还是同一张时什么也不用做
  function onShow({ id, index, total }) {
    V.total = total;
    if (photos.has(id)) {
      const moved = index !== V.host;
      seen.set(index, id);
      V.host = index;
      if (index === V.index) V.following = true; // 分享者翻到了这边正在看的这张，重新同步
      else if (V.following) display(index);
      else if (moved) nudge();
      if (!V.hinted && seen.size === 2) {
        V.hinted = true;
        toast(isTouch ? '左右滑动可以回看之前的照片' : '用方向键可以回看之前的照片');
      }
    }
    render();
  }

  // 超过之前的最多人数才提示有人加入：分享者从后台回来、大家陆续重连时人数也会一个个涨回去
  function onViewers(count) {
    if (V.peak && count > V.peak) toast(`又有人加入了，现在 ${count} 人在看`);
    V.viewers = count;
    V.peak = Math.max(V.peak, count);
    render();
  }

  function display(index) {
    const direction = V.index === -1 ? 0 : Math.sign(index - V.index);
    V.index = index;
    V.following = index === V.host;
    stage.show(photos.get(seen.get(index)), direction);
    wake();
    render();
  }

  // 在翻到过的照片里找 step 方向上最近的一张；分享者可能点缩略图跳着翻，所以不一定相邻
  function neighbor(step) {
    let best = null;
    for (const i of seen.keys()) {
      if ((i - V.index) * step > 0 && (best === null || Math.abs(i - V.index) < Math.abs(best - V.index))) best = i;
    }
    return best;
  }

  function go(step) {
    if (V.ended || V.index < 0) return;
    const index = neighbor(step);
    if (index === null) blocked(step);
    else display(index);
  }

  function blocked(step) {
    if (V.index < 0) return;
    if (step > 0) toast(V.index >= V.total - 1 ? '已经是最后一张了' : '后面的照片等对方翻到再看');
    else toast(V.index === 0 ? '已经是第一张了' : '前面的照片对方还没翻到');
  }

  // 自己翻看时分享者翻了页：不打断，只让“回到同步”按钮跳一下
  function nudge() {
    const button = $('#btn-resync');
    button.classList.remove('is-nudged');
    void button.offsetWidth;
    button.classList.add('is-nudged');
    wake();
  }

  function end(kind) {
    if (V.ended) return;
    V.ended = true;
    clearTimeout(retryTimer);
    clearTimeout(stallTimer);
    live.close();
    V.link?.reset();
    stage.clear();
    for (const url of photos.values()) URL.revokeObjectURL(url);
    photos.clear();
    seen.clear();
    showNotice(
      kind === 'gone'
        ? { title: '链接已失效', text: '这次分享已经结束，或者链接不完整。请让对方重新给你二维码。' }
        : { title: '分享已结束', text: '照片已从这台设备上清除。' },
    );
  }

  function render() {
    if (V.ended) return;
    const receiving = V.progress === null ? null : `${Math.round(V.progress * 100)}%`;
    let state = 'wait';
    let text = '正在连接…';
    if (V.p2p === 'open') [state, text] = ['live', receiving ? `正在接收 ${receiving}` : V.viewers ? `${V.viewers} 人在看` : '实时同步'];
    else if (V.p2p === 'disconnected') [state, text] = ['warn', '连接不稳，正在重连…'];
    else if (V.failures) [state, text] = ['warn', '连接中断，正在重试…'];
    else if (!V.link || V.signaling !== 'live') text = '正在连接…';
    $('#status').dataset.state = state;
    $('#status .chip-text').textContent = text;

    $('#counter').textContent = V.index >= 0 ? `${V.index + 1} / ${V.total}` : '';
    $('#btn-resync').hidden = V.following || V.host < 0;
    $('#resync-text').textContent = `回到同步 · 第 ${V.host + 1} 张`;
    $('#btn-prev').disabled = neighbor(-1) === null;
    $('#btn-next').disabled = neighbor(1) === null;
    $('#recv').classList.toggle('is-active', V.progress !== null);
    $('#recv').style.setProperty('--progress', V.progress ?? 0);

    let wait = null;
    if (V.index < 0) {
      if (V.p2p === 'open') wait = receiving ? `正在接收照片 ${receiving}` : '已连上，等对方翻开第一张照片…';
      else if (V.failures || V.stalled) wait = CONNECT_HINT;
      else if (V.link) wait = '正在连接对方…';
      else wait = '正在连接…';
    }
    $('#placeholder').hidden = !wait;
    $('#placeholder-text').textContent = wait ?? '';
  }

  // 一段时间没有变化后，悬浮信息淡出，让照片更突出；点一下照片显示或隐藏
  function wake() {
    stageEl.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stageEl.classList.add('is-idle'), 3000);
  }
  function rest() {
    clearTimeout(idleTimer);
    stageEl.classList.add('is-idle');
  }
  stageEl.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && wake());
  stageEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // 放大查看时把手势让给浏览器，用来拖动放大后的画面
  const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  window.visualViewport?.addEventListener('resize', () => stage.frame.classList.toggle('is-zoomed', zoomed()));

  bindSwipe(stage, {
    canStep: (step) => neighbor(step) !== null,
    step: go,
    blocked,
    tap: () => (stageEl.classList.contains('is-idle') ? wake() : rest()),
    enabled: () => !zoomed() && V.index >= 0,
  });
  $('#btn-prev').addEventListener('click', () => go(-1));
  $('#btn-next').addEventListener('click', () => go(1));
  $('#btn-resync').addEventListener('click', () => display(V.host));
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      go(step);
    } else if ((e.key === 'Enter' || e.key === 'Escape') && !V.following && V.host >= 0 && e.target === document.body) {
      display(V.host);
    }
  });

  const fullscreenButton = $('#btn-fullscreen');
  const root = document.documentElement;
  fullscreenButton.hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  fullscreenButton.addEventListener('click', () => {
    const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
    const enter = root.requestFullscreen ?? root.webkitRequestFullscreen;
    const result = document.fullscreenElement || document.webkitFullscreenElement ? exit.call(document) : enter.call(root);
    result?.catch?.(() => {});
  });

  keepScreenOn();
  render();
}
