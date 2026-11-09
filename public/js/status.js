// 状态栏和占位文字从当前状态推出来：这里只有纯函数，不碰页面，能直接在 Node 里测（test/status.test.js）。
// 返回的 key 是 i18n.js 里的文字，args 是文字的参数；state 是状态栏圆点的颜色（live 绿、warn 黄、wait 灰）。
// 页面把 key 写在状态栏的 data-status 上，排查和自动化测试时读它，不受界面语言影响。

/**
 * 分享者到某位观看者的一条连接（rtc.js 的 HostLink）现在处在哪一步：
 *   connecting 还没连上过，正在连。网络层已连通、通道还差一步时也算
 *   present    连着，对方在看
 *   away       连着，但对方切到后台或网络暂时中断
 *   lost       连上过又断开了
 *   failed     没连上就失败或关闭了
 */
export function linkPhase({ open, present, wasOpen, state }) {
  if (open) return present ? 'present' : 'away';
  if (wasOpen) return 'lost';
  return state === 'failed' || state === 'closed' ? 'failed' : 'connecting';
}

/**
 * 分享者的状态栏。conn 是分享者自己的实时通道（connecting、live、reconnecting，见 live.js）；
 * phases 是每条连接的 linkPhase；met 是这次分享里连上过几位观看者。
 * 有人在看时只显示人数：直连不经服务器，实时通道断了也照常翻看。
 */
export function hostStatus({ conn, phases, met }) {
  const present = phases.filter((p) => p === 'present').length;
  if (present) return { state: 'live', key: 'watching', args: [present] };
  if (conn !== 'live') return { state: 'warn', key: conn === 'connecting' ? 'connecting' : 'reconnecting' };
  if (phases.includes('connecting')) return { state: 'wait', key: 'friendConnecting' };
  if (met) return { state: 'wait', key: 'friendAway' };
  return { state: 'wait', key: 'waitingFriends' };
}

const OPENED = new Set(['present', 'away', 'lost']);
const UP = new Set(['present', 'away']);

/**
 * 有没有观看者第一次连上。peers 是 [peerId, linkPhase] 的列表，met 是之前连上过的 peerId。
 * 同一位观看者断线重连时换了一条新连接，但人还是那个人，不算加入。
 * 返回 { fresh, toast }：fresh 是第一次连上的 peerId，由调用方记进 met；
 * toast 是要提示的文字（{ key, args }），没人新加入时为 null。别人都没连着时提示怎么翻页，否则提示现在几人在看。
 */
export function arrivals(peers, met, { touch = false } = {}) {
  const fresh = peers.filter(([id, phase]) => OPENED.has(phase) && !met.has(id)).map(([id]) => id);
  if (!fresh.length) return { fresh, toast: null };
  const others = peers.some(([id, phase]) => UP.has(phase) && !fresh.includes(id));
  const present = peers.filter(([, phase]) => phase === 'present').length;
  const toast = others ? { key: 'joined', args: [present] } : { key: touch ? 'friendJoinedTouch' : 'friendJoinedMouse' };
  return { fresh, toast };
}

/**
 * 观看者的状态栏，以及舞台上还没有照片时的占位文字。
 *   p2p        和分享者的直连：idle、connecting、open、disconnected、failed、closed
 *   away       服务器说分享者的页面关掉了一阵（短暂断线不算，见 viewer.js 的 AWAY_DELAY_MS）
 *   hostHere   分享者经直连说自己的页面在前台
 *   hostOnline 服务器说分享者的页面开着
 *   failures   直连连续失败了几次；stalled：连了一阵还没连上
 *   linked     服务器已经接纳了这位观看者，在等分享者发起直连
 *   viewers    几人在看（分享者告知）
 *   receiving  分享者翻到的这张还一点都没显示出来时的接收进度（0–1），否则为 null
 *   blank      舞台上还没有照片
 * 返回 { state, key, args, wait }：wait 是占位文字（{ key, args }），舞台上有照片时为 null。
 */
export function viewerStatus({ p2p, away, hostHere, hostOnline, failures, stalled, linked, viewers, receiving, blank }) {
  const open = p2p === 'open';
  // 分享者切走了，或者离开了一阵、直连也断了。照片照常显示，也能回看，只在状态栏提示
  const hostAway = (away && !open) || (!hostHere && open);
  const percent = receiving === null ? null : `${Math.round(receiving * 100)}%`;

  let status;
  if (hostAway) status = { state: 'warn', key: 'hostAway' };
  else if (open && percent) status = { state: 'live', key: 'receiving', args: [percent] };
  else if (open && viewers) status = { state: 'live', key: 'watching', args: [viewers] };
  else if (open) status = { state: 'live', key: 'live' };
  else if (p2p === 'disconnected') status = { state: 'warn', key: 'unstable' };
  else if (failures) status = { state: 'warn', key: 'retrying' };
  else status = { state: 'wait', key: 'connecting' };

  return { ...status, wait: blank ? placeholder() : null };

  function placeholder() {
    if (hostAway) return { key: 'hostAwayText' };
    if (open && percent) return { key: 'receivingPhoto', args: [percent] };
    if (open) return { key: 'waitingFirst' };
    // 分享者的页面关着时不提示换网络：问题不在网络
    if (hostOnline && (failures || stalled)) return { key: 'connectHint' };
    if (linked) return { key: 'connectingPeer' };
    return { key: 'connecting' };
  }
}
