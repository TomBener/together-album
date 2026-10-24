import { $, api, showView, showNotice, keepScreenOn } from './util.js';
import { subscribe } from './live.js';
import { createStage } from './stage.js';
import { ViewerLink, randomId } from './rtc.js';

const RETRY_MS = 12_000; // 这么久还没直连上，就请分享者重新发起连接

export function startViewer(sessionId) {
  document.body.classList.add('role-viewer');
  showView('stage');
  const stage = createStage($('#frame'));
  const stageEl = $('#stage');
  const peerId = randomId(); // 整个页面生命周期不变，信令断线重连不会被当成新观看者
  const photos = new Map(); // 照片 id → blob URL，只有分享者翻到过的照片才会出现在这里
  const V = {
    link: null,
    p2p: 'idle',
    signaling: 'connecting',
    failures: 0,
    progress: null,
    index: -1,
    total: 0,
    ended: false,
  };
  let retryTimer = null;
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
          onProgress,
          onEnd: () => end('ended'),
        });
        if (V.p2p !== 'open') retryLater(RETRY_MS);
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

  function onShow({ id, index, total }) {
    V.total = total;
    const url = photos.get(id);
    if (url) {
      const direction = V.index === -1 ? 0 : Math.sign(index - V.index);
      V.index = index;
      stage.show(url, direction);
      wake();
    }
    render();
  }

  function end(kind) {
    if (V.ended) return;
    V.ended = true;
    clearTimeout(retryTimer);
    live.close();
    V.link?.reset();
    stage.clear();
    for (const url of photos.values()) URL.revokeObjectURL(url);
    photos.clear();
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
    let text = '正在建立直连…';
    if (V.p2p === 'open') [state, text] = ['live', receiving ? `正在接收 ${receiving}` : '直连 · 实时同步'];
    else if (V.p2p === 'disconnected') [state, text] = ['warn', '连接不稳，正在重连…'];
    else if (V.failures) [state, text] = ['warn', '直连中断，正在重试…'];
    else if (!V.link || V.signaling !== 'live') text = '正在连接…';
    $('#status').dataset.state = state;
    $('#status .chip-text').textContent = text;

    $('#counter').textContent = V.index >= 0 ? `${V.index + 1} / ${V.total}` : '';

    let wait = null;
    if (V.index < 0) {
      if (V.p2p === 'open') wait = receiving ? `正在接收照片 ${receiving}` : '已连上，等对方翻开第一张照片…';
      else if (V.failures) wait = '暂时没能和对方的设备直接连上。请让两台设备连同一个 Wi‑Fi，或者连上对方手机的个人热点，这里会自动重试。';
      else if (V.link) wait = '正在和对方的设备建立直连…';
      else wait = '正在连接…';
    }
    $('#placeholder').hidden = !wait;
    $('#placeholder-text').textContent = wait ?? '';
  }

  // 一段时间没有变化后，悬浮信息淡出，让照片更突出
  function wake() {
    stageEl.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stageEl.classList.add('is-idle'), 3000);
  }
  stageEl.addEventListener('pointerdown', wake);
  stageEl.addEventListener('contextmenu', (e) => e.preventDefault());

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
