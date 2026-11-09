import { $, api, toast, showView, showNotice, keepScreenOn, STALL_MS } from './util.js';
import { t, langQuery } from './i18n.js';
import { subscribe } from './live.js';
import { createStage, bindSwipe } from './stage.js';
import { ViewerLink, randomId } from './rtc.js';

const RETRY_MS = 15_000; // 这么久还没连上，就请分享者重新发起连接
const AWAY_DELAY_MS = 4000; // 分享者的信令断开这么久还没回来，才算“暂时离开”；常见的短暂断线不必惊动观看者
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
    hostOnline: true, // 分享者的页面开着（服务器告知）
    away: false, // 分享者离开了一阵：遮住照片，等对方回来
    relayed: false, // 经中转连上
    following: true, // 跟着分享者翻；自己翻到别处后为 false，直到回到分享者那一张
    hinted: false,
    stalled: false, // 连了一阵还没连上，改为显示怎么解决
    ended: false,
  };
  let retryTimer = null;
  let stallTimer = null;
  let awayTimer = null;
  let idleTimer = null;

  const signal = (data) =>
    api(`/api/sessions/${sessionId}/signal`, { method: 'POST', json: { peer: peerId, data } });

  const live = subscribe(`/api/sessions/${sessionId}/live?peer=${peerId}`, `/api/sessions/${sessionId}`, {
    onMessage(msg) {
      if (msg.type === 'welcome') {
        const first = !V.link;
        V.link ??= new ViewerLink({
          iceServers: msg.ice,
          signal,
          onState,
          onRoute,
          onPhoto,
          onShow,
          onViewers,
          onProgress,
          onEnd: () => end('ended'),
        });
        V.link.iceServers = msg.ice; // 服务器可能后来才领到中转凭证
        // 刚打开链接时分享者就不在：直接说明，不必等。之后信令重连时照常等几秒，免得短暂断线就遮住照片
        hostPresence(msg.hostOnline !== false, { now: first });
      } else if (msg.type === 'host') {
        hostPresence(msg.online);
      } else if (msg.type === 'ice') {
        if (V.link) V.link.iceServers = msg.ice;
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

  // 分享者的页面开着还是关着。关着时不催对方重连，也不提示换网络：问题不在网络
  function hostPresence(online, { now = false } = {}) {
    V.hostOnline = online;
    clearTimeout(awayTimer);
    if (online) {
      V.away = false;
      armStall();
      if (V.p2p !== 'open') retryLater(RETRY_MS);
    } else if (now) {
      V.away = true;
      disarmStall();
    } else {
      disarmStall();
      awayTimer = setTimeout(() => {
        V.away = true;
        render();
      }, AWAY_DELAY_MS);
    }
    render();
  }

  // 连了一阵还没连上，就告诉观看者怎么解决
  function armStall() {
    if (V.p2p === 'open' || stallTimer) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      V.stalled = true;
      render();
    }, STALL_MS);
  }

  function disarmStall() {
    clearTimeout(stallTimer);
    stallTimer = null;
    V.stalled = false;
  }

  // 请分享者重新发起连接。带上这边正在用的连接，分享者已经换了新连接时不再打断它
  function retryLater(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (V.ended || V.p2p === 'open') return;
      if (V.hostOnline) signal({ reconnect: true, link: V.link?.linkId ?? null }).catch(() => {});
      retryLater(RETRY_MS);
    }, ms);
  }

  function onState(state) {
    V.p2p = state;
    if (state === 'open') {
      clearTimeout(retryTimer);
      disarmStall();
      V.failures = 0;
    } else if (state === 'failed' || state === 'closed') {
      V.failures++;
      V.progress = null;
      V.relayed = false;
      retryLater(2000);
    } else if (state === 'disconnected') {
      retryLater(RETRY_MS); // 往往能自己恢复，先等一等
    }
    render();
  }

  function onRoute(relayed) {
    V.relayed = relayed;
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
        toast(t(isTouch ? 'lookBackTouch' : 'lookBackKeys'));
      }
    }
    render();
  }

  // 超过之前的最多人数才提示有人加入：分享者从后台回来、大家陆续重连时人数也会一个个涨回去
  function onViewers(count) {
    if (V.peak && count > V.peak) toast(t('joined', count));
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
    if (V.ended || V.index < 0 || paused()) return;
    const index = neighbor(step);
    if (index === null) blocked(step);
    else display(index);
  }

  function blocked(step) {
    if (V.index < 0) return;
    if (step > 0) toast(t(V.index >= V.total - 1 ? 'lastPhoto' : 'laterNotYet'));
    else toast(t(V.index === 0 ? 'firstPhoto' : 'earlierNotYet'));
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
    clearTimeout(awayTimer);
    live.close();
    V.link?.reset();
    stage.clear();
    for (const url of photos.values()) URL.revokeObjectURL(url);
    photos.clear();
    seen.clear();
    const home = { label: t('backHome'), href: `/${langQuery}` };
    showNotice(
      kind === 'gone'
        ? { title: t('linkGone'), text: t('linkGoneText'), action: home }
        : { title: t('shareEnded'), text: t('clearedHere'), action: home },
    );
  }

  // 分享者离开了一阵、直连也断了：遮住照片，回来后再显示
  function paused() {
    return V.away && V.p2p !== 'open';
  }

  function render() {
    if (V.ended) return;
    const away = paused();
    stageEl.classList.toggle('is-paused', away);
    const receiving = V.progress === null ? null : `${Math.round(V.progress * 100)}%`;
    let state = 'wait';
    let text = t('connecting');
    if (V.p2p === 'open') {
      state = 'live';
      text = receiving ? t('receiving', receiving) : V.viewers ? t('watching', V.viewers) : t('live');
      if (V.relayed && !receiving) text += ` · ${t('relayed')}`;
    } else if (away) [state, text] = ['warn', t('hostAway')];
    else if (V.p2p === 'disconnected') [state, text] = ['warn', t('unstable')];
    else if (V.failures) [state, text] = ['warn', t('retrying')];
    else if (!V.link || V.signaling !== 'live') text = t('connecting');
    $('#status').dataset.state = state;
    $('#status .chip-text').textContent = text;

    $('#counter').textContent = V.index >= 0 ? `${V.index + 1} / ${V.total}` : '';
    $('#btn-resync').hidden = away || V.following || V.host < 0;
    $('#resync-text').textContent = t('backToLive', V.host + 1);
    $('#btn-prev').disabled = away || neighbor(-1) === null;
    $('#btn-next').disabled = away || neighbor(1) === null;
    $('#recv').classList.toggle('is-active', V.progress !== null);
    $('#recv').style.setProperty('--progress', V.progress ?? 0);

    let wait = null;
    if (away) {
      wait = t('hostAwayText');
    } else if (V.index < 0) {
      if (V.p2p === 'open') wait = receiving ? t('receivingPhoto', receiving) : t('waitingFirst');
      else if (V.hostOnline && (V.failures || V.stalled)) wait = t('connectHint');
      else if (V.link) wait = t('connectingPeer');
      else wait = t('connecting');
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
    enabled: () => !zoomed() && V.index >= 0 && !paused(),
  });
  $('#btn-prev').addEventListener('click', () => go(-1));
  $('#btn-next').addEventListener('click', () => go(1));
  $('#btn-resync').addEventListener('click', () => !paused() && display(V.host));
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      go(step);
    } else if ((e.key === 'Enter' || e.key === 'Escape') && !V.following && V.host >= 0 && !paused() && e.target === document.body) {
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
