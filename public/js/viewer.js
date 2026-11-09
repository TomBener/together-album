import { $, api, toast, showView, showNotice, keepScreenOn, STALL_MS, DEBUG } from './util.js';
import { t, langQuery } from './i18n.js';
import { subscribe } from './live.js';
import { createStage, bindSwipe } from './stage.js';
import { ViewerLink, randomId } from './rtc.js';
import { unseal, fromBase64 } from './seal.js';

const RETRY_MS = 15_000; // 这么久还没连上，就请分享者重新发起连接
const AWAY_DELAY_MS = 4000; // 分享者的信令断开这么久还没回来，才算“暂时离开”；常见的短暂断线不必惊动观看者
const isTouch = matchMedia('(hover: none)').matches;

export function startViewer(sessionId) {
  document.body.classList.add('role-viewer');
  showView('stage');
  const stageEl = $('#stage');
  const stage = createStage(stageEl);
  const peerId = randomId(); // 整个页面生命周期不变，信令断线重连不会被当成新观看者
  // 照片 id → { index, secret, parts, urls, chain }：分享者翻到它时是第几张（没翻到为 -1）、它的钥匙、
  // 收到了还没打开的数据（preview、full）、打开后能显示的地址。提前收到的照片没有钥匙，打不开
  const pics = new Map();
  // 第几张 → 照片 id。只记分享者翻到过、而且已经能显示的照片，观看者只能在这些照片里来回翻
  const seen = new Map();
  const V = {
    link: null,
    p2p: 'idle',
    signaling: 'connecting',
    failures: 0,
    progress: null,
    index: -1, // 这台设备正在看的
    host: -1, // 分享者正在看的
    hostId: null,
    shownId: null, // 舞台上这张照片的 id
    shownKind: null, // 舞台上是预览（preview）还是原画质（full）
    total: 0,
    viewers: 0, // 几人在看，由分享者告知
    peak: 0, // 这次分享里最多同时几人在看
    hostOnline: true, // 分享者的页面开着（服务器告知）
    hostHere: true, // 分享者的页面在前台（分享者经直连告知，比服务器快）
    away: false, // 分享者离开了一阵。照片照常显示，状态栏提示一下
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
          have,
          onState,
          onRoute,
          onPart,
          onShow,
          onViewers,
          onProgress,
          onHere,
          onEnd: () => end('ended'),
        });
        V.link.iceServers = msg.ice; // 服务器可能后来才领到中转凭证
        // 刚打开链接时分享者就不在：直接说明，不必等。之后信令重连时照常等几秒，免得短暂断线就提示“对方暂时离开”
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

  // 分享者切到别的 App、锁屏或回来了
  function onHere(on) {
    V.hostHere = on;
    render();
  }

  function onRoute(relayed) {
    V.relayed = relayed;
    render();
  }

  // 只显示分享者正在看的这张的进度；提前发的照片在后台传，不显示
  function onProgress({ id, kind, fraction }) {
    if (id !== V.hostId || !V.following) return;
    const p = pics.get(id);
    if (!p || p.urls.full || (kind === 'preview' && p.urls.preview)) return;
    V.progress = fraction;
    render();
  }

  const pic = (id) => {
    let p = pics.get(id);
    if (!p) pics.set(id, (p = { index: -1, secret: null, parts: {}, urls: {}, chain: Promise.resolve() }));
    return p;
  };
  const bestUrl = (p) => p?.urls.full ?? p?.urls.preview;

  // 已经能显示的照片。连接断了又连上时告诉分享者，不必重发
  function have() {
    const parts = [];
    for (const [id, p] of pics) for (const kind of ['preview', 'full']) if (p.urls[kind]) parts.push(`${id}:${kind}`);
    return parts;
  }

  // 收到一张照片的预览或原画质。分享者已经翻到这张（有钥匙）就打开，否则先存着
  function onPart({ id, kind, type, iv, data }) {
    if (V.ended) return;
    const p = pic(id);
    if (p.urls[kind]) return;
    p.parts[kind] = { type, iv, data };
    unlock(id);
  }

  // 有钥匙（或本来没加密）的数据解开，生成能显示的地址
  function unlock(id) {
    const p = pics.get(id);
    for (const kind of ['preview', 'full']) {
      const part = p.parts[kind];
      if (!part || (part.iv && !p.secret)) continue;
      p.parts[kind] = null;
      const secret = p.secret;
      p.chain = p.chain.then(async () => {
        if (p.urls[kind]) return;
        let blob;
        try {
          const data = part.iv ? await unseal(secret, fromBase64(part.iv), await part.data.arrayBuffer()) : part.data;
          blob = new Blob([data], { type: part.type });
        } catch {
          // 钥匙对不上：分享者重新打开过页面、换了钥匙。数据留着，等新钥匙或重发的数据到了再试
          if (!p.parts[kind]) p.parts[kind] = part;
          return;
        }
        if (V.ended) return;
        p.urls[kind] = URL.createObjectURL(blob);
        arrived(id, kind);
      });
    }
  }

  // 分享者翻页、加照片或重连时都会发来，带着这张照片的钥匙；张数变了但还是同一张时什么也不用做
  function onShow({ id, index, total, key }) {
    if (typeof id !== 'string' || !Number.isInteger(index)) return;
    V.total = total;
    const p = pic(id);
    if (typeof key === 'string') {
      try {
        p.secret = fromBase64(key);
      } catch {
        // 钥匙格式不对：当作没有
      }
    }
    p.index = index;
    const moved = id !== V.hostId;
    V.host = index;
    V.hostId = id;
    if (moved) V.progress = null;
    if (id === V.shownId) V.following = true; // 分享者翻到了这边正在看的这张，重新同步
    unlock(id);
    if (bestUrl(p)) reveal(id, moved);
    else if (moved && !V.following) nudge();
    render();
  }

  // 预览或原画质打开了
  function arrived(id, kind) {
    const p = pics.get(id);
    if (p.index < 0) return; // 分享者还没翻到这张
    if (id === V.shownId) {
      if (kind === 'full' && V.shownKind !== 'full') sharpen();
    } else if (id === V.hostId) {
      reveal(id, false);
    } else if (!seen.has(p.index)) {
      seen.set(p.index, id); // 分享者翻过、没停留的照片，之后也能回看
    }
    if (id === V.hostId && p.urls.full) V.progress = null;
    render();
  }

  // 分享者正在看的这张能显示了：跟着翻的话马上换上，自己在回看时只提示一下
  function reveal(id, moved) {
    const p = pics.get(id);
    const fresh = seen.get(p.index) !== id;
    seen.set(p.index, id);
    if (V.following) display(p.index);
    else if (moved || fresh) nudge();
    if (!V.hinted && seen.size === 2) {
      V.hinted = true;
      toast(t(isTouch ? 'lookBackTouch' : 'lookBackKeys'));
    }
  }

  // 舞台上的预览换成原画质，原地淡入
  function sharpen() {
    const url = pics.get(V.shownId)?.urls.full;
    if (!url) return;
    V.shownKind = 'full';
    stage.show(url, 0, { swap: true });
  }

  // 超过之前的最多人数才提示有人加入：分享者从后台回来、大家陆续重连时人数也会一个个涨回去
  function onViewers(count) {
    if (V.peak && count > V.peak) toast(t('joined', count));
    V.viewers = count;
    V.peak = Math.max(V.peak, count);
    render();
  }

  function display(index) {
    const id = seen.get(index);
    const p = pics.get(id);
    const url = bestUrl(p);
    if (!url) return;
    const direction = V.index === -1 ? 0 : Math.sign(index - V.index);
    const swap = id === V.shownId; // 同一张从预览换成原画质
    V.index = index;
    V.shownId = id;
    V.shownKind = p.urls.full ? 'full' : 'preview';
    V.following = index === V.host;
    stage.show(url, swap ? 0 : direction, { swap });
    wake();
    render();
  }

  // 回到分享者正在看的这张；还没收到的话，收到后自动换上
  function resync() {
    V.following = true;
    if (seen.get(V.host) === V.hostId) display(V.host);
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
    for (const p of pics.values()) for (const url of Object.values(p.urls)) URL.revokeObjectURL(url);
    pics.clear();
    seen.clear();
    const home = { label: t('backHome'), href: `/${langQuery}` };
    showNotice(
      kind === 'gone'
        ? { title: t('linkGone'), text: t('linkGoneText'), action: home }
        : { title: t('shareEnded'), text: t('clearedHere'), action: home },
    );
  }

  function render() {
    if (V.ended) return;
    // 分享者切走了，或者离开了一阵、直连也断了。照片照常显示，也能回看，只在状态栏提示
    const away = (V.away && V.p2p !== 'open') || (!V.hostHere && V.p2p === 'open');
    const loading = V.progress !== null && V.following;
    // 分享者翻到的这张还一点都没显示出来时，状态栏显示接收进度；预览出来后只留顶部的进度条
    const receiving = loading && V.shownId !== V.hostId ? `${Math.round(V.progress * 100)}%` : null;
    let state = 'wait';
    let text = t('connecting');
    if (away) {
      [state, text] = ['warn', t('hostAway')];
    } else if (V.p2p === 'open') {
      state = 'live';
      text = receiving ? t('receiving', receiving) : V.viewers ? t('watching', V.viewers) : t('live');
      if (DEBUG && V.relayed && !receiving) text += ` · ${t('relayed')}`; // 排查用（网址带 ?debug=1）
    } else if (V.p2p === 'disconnected') [state, text] = ['warn', t('unstable')];
    else if (V.failures) [state, text] = ['warn', t('retrying')];
    else if (!V.link || V.signaling !== 'live') text = t('connecting');
    $('#status').dataset.state = state;
    $('#status .chip-text').textContent = text;

    $('#counter').textContent = V.index >= 0 ? `${V.index + 1} / ${V.total}` : '';
    $('#btn-resync').hidden = V.following || V.host < 0;
    $('#resync-text').textContent = t('backToLive', V.host + 1);
    $('#btn-prev').disabled = neighbor(-1) === null;
    $('#btn-next').disabled = neighbor(1) === null;
    $('#recv').classList.toggle('is-active', loading);
    $('#recv').style.setProperty('--progress', V.progress ?? 0);

    let wait = null;
    if (V.index < 0) {
      if (away) wait = t('hostAwayText');
      else if (V.p2p === 'open') wait = receiving ? t('receivingPhoto', receiving) : t('waitingFirst');
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
    enabled: () => !zoomed() && V.index >= 0,
  });
  $('#btn-prev').addEventListener('click', () => go(-1));
  $('#btn-next').addEventListener('click', () => go(1));
  $('#btn-resync').addEventListener('click', resync);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      go(step);
    } else if ((e.key === 'Enter' || e.key === 'Escape') && !V.following && V.host >= 0 && e.target === document.body) {
      resync();
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

  // 切到别的 App、锁屏或关掉页面时告诉分享者，他那边显示“朋友暂时离开”
  document.addEventListener('visibilitychange', () => V.link?.sendHere(document.visibilityState === 'visible'));
  window.addEventListener('pagehide', () => V.link?.sendHere(false));

  keepScreenOn();
  render();
}
