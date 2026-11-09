const STALE_MS = 45_000; // 服务端每 20 秒发一次心跳
const OPEN_TIMEOUT_MS = 10_000; // 握手这么久还没完成就放弃重来；网络差时浏览器自己要等一两分钟才报错

/**
 * 订阅会话的实时消息（WebSocket），断线自动重连。另外处理三件事：
 * 会话已不存在（404）时通知调用方；握手迟迟不完成时重来；手机从后台回来时把“僵死”的连接换掉。
 */
export function subscribe(path, statusUrl, { onMessage, onStatus, onGone }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  let socket = null;
  let lastSeen = Date.now();
  let closed = false;
  let retryTimer = null;
  let openTimer = null;
  let attempt = 0;

  const open = () => {
    clearTimeout(retryTimer);
    clearTimeout(openTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    lastSeen = Date.now();
    const ws = (socket = new WebSocket(url));
    openTimer = setTimeout(() => {
      if (closed || ws !== socket || ws.readyState !== WebSocket.CONNECTING) return;
      ws.onclose = null;
      ws.close();
      onStatus('reconnecting');
      probe();
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(openTimer);
      attempt = 0;
      lastSeen = Date.now();
      onStatus('live');
    };
    ws.onmessage = (event) => {
      lastSeen = Date.now();
      const msg = JSON.parse(event.data);
      if (msg.type !== 'ping') onMessage(msg);
    };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (closed || ws !== socket) return;
      onStatus('reconnecting');
      probe();
    };
  };

  // 连接断了：先问一下会话还在不在，在的话退避重连
  const probe = async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OPEN_TIMEOUT_MS); // 网络差时 fetch 也可能一直挂着
    try {
      const res = await fetch(statusUrl, { cache: 'no-store', signal: abort.signal });
      if (res.status === 404) {
        close();
        onGone();
        return;
      }
    } catch {
      // 网络问题，稍后重试
    } finally {
      clearTimeout(timer);
    }
    if (!closed) retryTimer = setTimeout(open, Math.min(1000 * 2 ** attempt++, 8000));
  };

  const reviveIfStale = (limit) => {
    if (closed || Date.now() - lastSeen < limit) return;
    onStatus('reconnecting');
    open();
  };
  const watchdog = setInterval(() => reviveIfStale(STALE_MS), 10_000);
  const onVisible = () => document.visibilityState === 'visible' && reviveIfStale(25_000);
  document.addEventListener('visibilitychange', onVisible);

  const close = () => {
    closed = true;
    socket?.close();
    clearInterval(watchdog);
    clearTimeout(retryTimer);
    clearTimeout(openTimer);
    document.removeEventListener('visibilitychange', onVisible);
  };

  open();
  return { close };
}
