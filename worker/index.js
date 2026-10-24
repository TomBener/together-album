import { DurableObject } from 'cloudflare:workers';
import QRCode from 'qrcode/lib/core/qrcode.js';
import SvgTag from 'qrcode/lib/renderer/svg-tag.js';

// 线上版本的信令服务器（Cloudflare Workers + Durable Objects），接口与 server/app.js 完全一致，前端无需区分。
// 每个分享会话是一个 Durable Object：保存分享者密钥、管理双方的 WebSocket、转发建立直连的信令。
// 照片走 WebRTC 点对点直传，不经过这里；直连不通时经 Cloudflare 的 TURN 中继转发，中继只见到加密后的数据。

const HEARTBEAT_MS = 20_000; // 低于 Cloudflare 的 100 秒空闲断流
const HOST_AWAY_MS = 60 * 60 * 1000; // 分享者离线超过 1 小时自动结束
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 无论如何 6 小时后结束
const MAX_VIEWERS = 12;
const MAX_SIGNAL_BYTES = 64 * 1024;

// STUN 只用来让设备知道自己的公网地址，不经手照片。可用 ICE_SERVERS 变量覆盖（JSON 数组）。
const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
// 开着代理、在校园网或部分蜂窝网络里时直连常常不通，这时改走 TURN 中继。
// 每次分享生成一组临时凭证，有效期比会话最长时长多一小时，会话结束时吊销。
const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TURN_TTL_S = MAX_AGE_MS / 1000 + 3600;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self'; " +
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const VIEWER_PAGE = /^\/v\/[\w-]{16,64}\/?$/;
const SESSION_PATH = /^\/api\/sessions\/([\w-]{16,64})(?:\/(live|signal|qr))?\/?$/;
const PEER_ID = /^[\w-]{16,64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/sessions' || pathname === '/api/sessions/') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      if (env.CREATE_LIMIT && !(await env.CREATE_LIMIT.limit({ key: ip })).success) {
        return json({ error: 'too_many_sessions' }, 429);
      }
      const id = token(16);
      const session = await stubFor(env, id).create(id, url.origin);
      return json(session, 201);
    }

    const match = pathname.match(SESSION_PATH);
    if (match) return stubFor(env, match[1]).fetch(request);
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    if (pathname === '/healthz') return withHeaders(new Response('ok'));

    // 首页和加入页是同一个页面，补上安全响应头
    if (pathname === '/' || VIEWER_PAGE.test(pathname)) {
      // 静态资源默认把 /index.html 重定向到 /，所以直接取 /
      const page = await env.ASSETS.fetch(new Request(new URL('/', url), request));
      return withHeaders(new Response(page.body, page), { 'Cache-Control': 'no-cache' });
    }
    return env.ASSETS.fetch(request);
  },
};

const stubFor = (env, id) => env.SESSIONS.get(env.SESSIONS.idFromName(id));

export class SessionRoom extends DurableObject {
  /** 由入口 Worker 通过 RPC 调用，初始化一个新会话。 */
  async create(id, origin) {
    const now = Date.now();
    const meta = {
      id,
      hostKey: token(24),
      joinUrls: [{ label: '公网', url: `${origin}/v/${id}` }],
      ice: await this.issueIceServers(),
      createdAt: now,
      hostSeenAt: now,
    };
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(now + HOST_AWAY_MS);
    return { id, hostKey: meta.hostKey, joinUrls: meta.joinUrls, ice: meta.ice };
  }

  async fetch(request) {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return json({ error: 'not_found' }, 404);
    const url = new URL(request.url);
    const action = url.pathname.match(SESSION_PATH)[2];
    const host = await isHost(request, url, meta.hostKey);
    const { method } = request;

    if (!action && method === 'GET') return json({ ok: true });
    if (!action && method === 'DELETE') {
      if (!host) return json({ error: 'unauthorized' }, 401);
      await this.end('host');
      return json({ ok: true });
    }
    if (action === 'live' && method === 'GET') return this.accept(request, url, meta, host);
    if (action === 'signal' && method === 'POST') return this.relay(request, meta, host);
    if (action === 'qr' && method === 'GET') return this.qr(url, meta);
    return json({ error: 'not_found' }, 404);
  }

  // ---- 实时通道（WebSocket，使用休眠 API） ----

  async accept(request, url, meta, host) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade_required' }, 426);
    if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
    const peerId = host ? null : url.searchParams.get('peer');
    if (!host && !PEER_ID.test(peerId ?? '')) return json({ error: 'bad_peer' }, 400);

    // 同一页面断线重连会带着同一个 peerId 回来，替换旧连接而不是算作新观看者
    const previous = host ? [] : this.ctx.getWebSockets(`peer:${peerId}`);
    if (!host && !previous.length && this.peerIds().length >= MAX_VIEWERS) return json({ error: 'full' }, 429);
    for (const old of previous) {
      old.serializeAttachment({ ...old.deserializeAttachment(), gone: true });
      safeClose(old, 4001, 'replaced');
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, host ? ['host'] : ['peer', `peer:${peerId}`]);
    server.serializeAttachment({ host, peerId, gone: false });

    if (host) {
      meta.hostSeenAt = Date.now();
      await this.ctx.storage.put('meta', meta);
      // 分享者（重新）连上时拿到完整名单，自行补连还没直连上的观看者
      send(server, { type: 'hello', peers: this.peerIds(), joinUrls: meta.joinUrls });
    } else {
      send(server, { type: 'welcome', peerId, ice: meta.ice ?? this.iceServers() });
      this.toHosts({ type: 'peer-join', peerId });
    }
    await this.scheduleHeartbeat();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {
    // 客户端不通过这条通道发消息
  }

  async webSocketClose(ws, code) {
    safeClose(ws, code === 1005 || code === 1006 ? 1000 : code);
    await this.onDisconnect(ws);
  }

  async webSocketError(ws) {
    await this.onDisconnect(ws);
  }

  async onDisconnect(ws) {
    const info = ws.deserializeAttachment();
    if (!info || info.gone) return;
    ws.serializeAttachment({ ...info, gone: true });
    if (!info.host) return this.toHosts({ type: 'peer-leave', peerId: info.peerId });
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return;
    meta.hostSeenAt = Date.now();
    await this.ctx.storage.put('meta', meta);
  }

  // ---- 信令转发 ----

  async relay(request, meta, host) {
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_SIGNAL_BYTES) return json({ error: 'too_large' }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad_json' }, 400);
    }
    if (typeof body?.data !== 'object' || body.data === null) return json({ error: 'bad_signal' }, 400);

    if (host) {
      // 分享者 → 某位观看者
      const target = this.openPeer(body.to);
      if (!target) return json({ error: 'no_peer' }, 404);
      send(target, { type: 'signal', data: body.data });
      meta.hostSeenAt = Date.now();
      await this.ctx.storage.put('meta', meta);
    } else {
      // 观看者 → 分享者：必须是当前在线的观看者；分享者不在线时直接丢弃，对方会重试
      if (!this.openPeer(body.peer)) return json({ error: 'unknown_peer' }, 403);
      this.toHosts({ type: 'signal', from: body.peer, data: body.data });
    }
    return json({ ok: true }, 202);
  }

  // ---- 心跳与过期 ----

  async alarm() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return;
    const now = Date.now();
    if (this.live('host').length) {
      meta.hostSeenAt = now;
      await this.ctx.storage.put('meta', meta);
    }
    if (now - meta.createdAt > MAX_AGE_MS) return this.end('expired');
    if (now - meta.hostSeenAt > HOST_AWAY_MS) return this.end('host_away');

    const sockets = this.live();
    for (const ws of sockets) send(ws, { type: 'ping' });
    // 有人在线时 20 秒一次心跳；没人时只等到该过期的时候再醒
    const next = sockets.length ? now + HEARTBEAT_MS : Math.min(meta.hostSeenAt + HOST_AWAY_MS, meta.createdAt + MAX_AGE_MS);
    await this.ctx.storage.setAlarm(next + 1000);
  }

  async scheduleHeartbeat() {
    const due = Date.now() + HEARTBEAT_MS;
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > due) await this.ctx.storage.setAlarm(due);
  }

  async end(reason) {
    const meta = await this.ctx.storage.get('meta');
    for (const ws of this.ctx.getWebSockets()) {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), gone: true });
      send(ws, { type: 'ended', reason });
      safeClose(ws, 4000, 'ended');
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.revokeTurn(meta?.ice);
  }

  // ---- 工具 ----

  /** 还在线的连接（排除已被替换或已断开的）。 */
  live(tag) {
    return this.ctx.getWebSockets(tag).filter((ws) => !ws.deserializeAttachment()?.gone);
  }

  peerIds() {
    return [...new Set(this.live('peer').map((ws) => ws.deserializeAttachment().peerId))];
  }

  openPeer(peerId) {
    if (!PEER_ID.test(peerId ?? '')) return null;
    return this.live(`peer:${peerId}`)[0] ?? null;
  }

  toHosts(msg) {
    for (const ws of this.live('host')) send(ws, msg);
  }

  iceServers() {
    try {
      const custom = JSON.parse(this.env.ICE_SERVERS ?? 'null');
      if (Array.isArray(custom)) return custom;
    } catch {
      // 配置不合法时用默认值
    }
    return DEFAULT_ICE_SERVERS;
  }

  /** 生成这次分享专用的 TURN 临时凭证。没配置 TURN 密钥、用 ICE_SERVERS 覆盖或接口出错时只用 STUN。 */
  async issueIceServers() {
    const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: apiToken, ICE_SERVERS: custom } = this.env;
    if (!keyId || !apiToken || custom) return this.iceServers();
    try {
      const res = await fetch(`${TURN_API}/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { iceServers } = await res.json();
      // 浏览器会拦截 53 端口，留着只会白等超时
      return iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }));
    } catch (err) {
      console.error('TURN credentials unavailable, falling back to STUN:', err.message);
      return this.iceServers();
    }
  }

  async revokeTurn(ice) {
    const username = ice?.find((s) => s.username)?.username;
    const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: apiToken } = this.env;
    if (!username || !keyId || !apiToken) return;
    try {
      await fetch(`${TURN_API}/${keyId}/credentials/${encodeURIComponent(username)}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 吊销失败也无妨，凭证到期自然失效
    }
  }

  qr(url, meta) {
    const entry = meta.joinUrls[Number(url.searchParams.get('u') ?? 0)];
    if (!entry) return json({ error: 'not_found' }, 404);
    const svg = SvgTag.render(QRCode.create(entry.url, { errorCorrectionLevel: 'M' }), {
      margin: 0,
      color: { dark: '#111111', light: '#ffffff' },
    });
    return withHeaders(new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }), {
      'Cache-Control': 'private, no-store',
    });
  }
}

// ---- 工具函数 ----

function token(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function isHost(request, url, hostKey) {
  const auth = request.headers.get('Authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key');
  if (!given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(hostKey);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // 非浏览器客户端
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 连接已断开
  }
}

function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // 已经关闭
  }
}

function withHeaders(response, extra = {}) {
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) response.headers.set(k, v);
  return response;
}

function json(body, status = 200) {
  return withHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    { 'Cache-Control': 'no-store' },
  );
}
