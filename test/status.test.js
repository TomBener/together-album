import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkPhase, hostStatus, arrivals, viewerStatus } from '../public/js/status.js';

// 只比较 key 和参数，不比较界面文字
const shown = ({ state, key, args }) => [state, key, ...(args ?? [])];

test('连接的阶段：连着时看对方在不在，没连着时看连上过没有', () => {
  assert.equal(linkPhase({ open: true, present: true, wasOpen: true, state: 'open' }), 'present');
  assert.equal(linkPhase({ open: true, present: false, wasOpen: true, state: 'open' }), 'away');
  assert.equal(linkPhase({ open: false, present: false, wasOpen: true, state: 'disconnected' }), 'lost');
  assert.equal(linkPhase({ open: false, present: false, wasOpen: false, state: 'connecting' }), 'connecting');
  assert.equal(linkPhase({ open: false, present: false, wasOpen: false, state: 'connected' }), 'connecting');
  assert.equal(linkPhase({ open: false, present: false, wasOpen: false, state: 'failed' }), 'failed');
  assert.equal(linkPhase({ open: false, present: false, wasOpen: false, state: 'closed' }), 'failed');
});

test('分享者的状态栏：有人在看时只显示人数，实时通道断了也一样', () => {
  assert.deepEqual(shown(hostStatus({ conn: 'reconnecting', phases: ['present', 'away', 'present'], met: 3 })), ['live', 'watching', 2]);
});

test('分享者的状态栏：没人在看时，先看自己的实时通道，再看朋友', () => {
  const host = (conn, phases, met = 0) => shown(hostStatus({ conn, phases, met }));
  assert.deepEqual(host('connecting', []), ['warn', 'connecting']);
  assert.deepEqual(host('reconnecting', ['connecting']), ['warn', 'reconnecting']);
  assert.deepEqual(host('live', ['away', 'connecting'], 1), ['wait', 'friendConnecting']);
  assert.deepEqual(host('live', ['away'], 1), ['wait', 'friendAway']);
  assert.deepEqual(host('live', ['lost', 'failed'], 1), ['wait', 'friendAway']);
  assert.deepEqual(host('live', ['failed']), ['wait', 'waitingFriends']);
  assert.deepEqual(host('live', []), ['wait', 'waitingFriends']);
});

test('第一位朋友连上：提示怎么翻页', () => {
  const met = new Set();
  const { fresh, toast } = arrivals([['a', 'present']], met, { touch: true });
  assert.deepEqual(fresh, ['a']);
  assert.deepEqual(toast, { key: 'friendJoinedTouch' });
  assert.deepEqual(arrivals([['a', 'away']], met).toast, { key: 'friendJoinedMouse' });
});

test('又有朋友连上：提示现在几人在看', () => {
  const { fresh, toast } = arrivals([['a', 'present'], ['b', 'present']], new Set(['a']));
  assert.deepEqual(fresh, ['b']);
  assert.deepEqual(toast, { key: 'joined', args: [2] });
});

test('同一位朋友断线重连、从后台回来：不算加入', () => {
  const met = new Set(['a', 'b']);
  assert.equal(arrivals([['a', 'connecting'], ['b', 'present']], met).toast, null);
  assert.equal(arrivals([['a', 'present'], ['b', 'present']], met).toast, null);
  assert.equal(arrivals([['a', 'away']], met).toast, null);
  // 还没连上的不算
  assert.deepEqual(arrivals([['c', 'connecting'], ['d', 'failed']], met), { fresh: [], toast: null });
});

test('朋友刷新了页面（换了新的 peerId），别人都不在：当作第一位朋友', () => {
  assert.deepEqual(arrivals([['a', 'lost'], ['a2', 'present']], new Set(['a'])).toast, { key: 'friendJoinedMouse' });
});

const viewer = (over) =>
  viewerStatus({
    p2p: 'idle',
    away: false,
    hostHere: true,
    hostOnline: true,
    failures: 0,
    stalled: false,
    linked: false,
    viewers: 0,
    receiving: null,
    blank: true,
    ...over,
  });
const wait = (status) => (status.wait ? [status.wait.key, ...(status.wait.args ?? [])] : null);

test('观看者刚打开链接：正在连接', () => {
  assert.deepEqual(shown(viewer({})), ['wait', 'connecting']);
  assert.deepEqual(wait(viewer({})), ['connecting']);
  assert.deepEqual(wait(viewer({ linked: true, p2p: 'connecting' })), ['connectingPeer']);
});

test('观看者连了一阵还没连上：分享者在线时才提示换网络', () => {
  assert.deepEqual(wait(viewer({ linked: true, stalled: true })), ['connectHint']);
  assert.deepEqual(wait(viewer({ linked: true, failures: 1 })), ['connectHint']);
  assert.deepEqual(wait(viewer({ linked: true, failures: 1, hostOnline: false })), ['connectingPeer']);
  assert.deepEqual(shown(viewer({ linked: true, failures: 2, p2p: 'connecting' })), ['warn', 'retrying']);
  assert.deepEqual(shown(viewer({ linked: true, p2p: 'disconnected' })), ['warn', 'unstable']);
});

test('观看者连上了：显示接收进度、人数或实时同步', () => {
  assert.deepEqual(shown(viewer({ p2p: 'open', receiving: 0.426 })), ['live', 'receiving', '43%']);
  assert.deepEqual(wait(viewer({ p2p: 'open', receiving: 0 })), ['receivingPhoto', '0%']);
  assert.deepEqual(wait(viewer({ p2p: 'open' })), ['waitingFirst']);
  assert.deepEqual(shown(viewer({ p2p: 'open', viewers: 3 })), ['live', 'watching', 3]);
  assert.deepEqual(shown(viewer({ p2p: 'open', blank: false })), ['live', 'live']);
  assert.equal(viewer({ p2p: 'open', blank: false }).wait, null);
});

test('分享者暂时离开：直连通着时听分享者自己说的，断了时听服务器的', () => {
  assert.deepEqual(shown(viewer({ p2p: 'open', hostHere: false })), ['warn', 'hostAway']);
  assert.deepEqual(shown(viewer({ p2p: 'open', away: true })), ['live', 'live']);
  assert.deepEqual(shown(viewer({ p2p: 'closed', away: true, failures: 1 })), ['warn', 'hostAway']);
  assert.deepEqual(shown(viewer({ p2p: 'closed', hostHere: false, failures: 1 })), ['warn', 'retrying']);
  assert.deepEqual(wait(viewer({ away: true, hostOnline: false })), ['hostAwayText']);
});
