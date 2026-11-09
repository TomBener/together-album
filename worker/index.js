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

// STUN 只用来让设备知道自己的公网地址，不经手照片。Google 的 STUN 在国内连不上，换成国内能连上的小米。
// 可用 ICE_SERVERS 变量覆盖（JSON 数组），覆盖后不再申请 TURN 凭证。
const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478'] }];
// 校园网、手机网络常是对称型 NAT，开着 VPN 时也打不通，这时改走 TURN 中继。
// 每次分享生成一组临时凭证，有效期比会话最长时长多一小时，会话结束时吊销。
const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TURN_TTL_S = MAX_AGE_MS / 1000 + 3600;
// 只留两个地址：UDP 最快；443 端口的 TLS 能穿过只放行网页的防火墙和代理。地址多了会拖慢连接
const TURN_URL = /^turn:[^?]+:3478\?transport=udp$|^turns:[^?]+:443\?transport=tcp$/;
const TURN_RETRY_MS = 30_000; // 申请中转凭证失败后，至少隔这么久再试

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
      // 每次开始分享都会领一组中继凭证，限制同一地址开新分享的频率，防止有人批量领取
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
      // 分享卡片的缩略图要写完整网址，有的抓取方不认相对路径
      const withImage = new HTMLRewriter()
        .on('meta[property="og:image"]', {
          element(el) {
            el.setAttribute('content', new URL(el.getAttribute('content'), url.origin).href);
          },
        })
        .transform(page);
      return withHeaders(new Response(withImage.body, withImage), { 'Cache-Control': 'no-cache' });
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
      // 分享者在本机加密暂存照片用的钥匙，只给分享者。会话结束或过期时随会话删除，暂存的照片就再也打不开
      keepKey: token(32),
      joinUrls: [{ kind: 'public', url: `${origin}/v/${id}` }],
      ice: await this.issueIceServers(),
      iceTriedAt: now,
      createdAt: now,
      hostSeenAt: now,
    };
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(now + HOST_AWAY_MS);
    return { id, hostKey: meta.hostKey, keepKey: meta.keepKey, joinUrls: meta.joinUrls, ice: meta.ice };
  }

  async fetch(request) {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return json({ error: 'not_found' }, 404);
    const url = new URL(request.url);
    const action = url.pathname.match(SESSION_PATH)[2];
    const host = await isHost(request, url, meta.hostKey);
    const { method } = request;

    if (!action && method === 'GET') return json(host ? { ok: true, keepKey: meta.keepKey } : { ok: true });
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

    await this.ensureRelay(meta);
    const ice = meta.ice ?? this.iceServers();
    if (host) {
      meta.hostSeenAt = Date.now();
      await this.ctx.storage.put('meta', meta);
      // 分享者（重新）连上时拿到完整名单和连接配置，自行补连还没连上的观看者。
      // 关掉的分享页重新打开时也走这里，所以连接配置要从这里给
      send(server, { type: 'hello', peers: this.peerIds(), joinUrls: meta.joinUrls, ice, keepKey: meta.keepKey });
      // 观看者据此区分“对方暂时离开了”和“网络连不上”
      this.toPeers({ type: 'host', online: true });
    } else {
      send(server, { type: 'welcome', peerId, ice, hostOnline: this.live('host').length > 0 });
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
    if (!this.live('host').length) this.toPeers({ type: 'host', online: false });
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
      // 观看者 → 分享者：必须是当前在线的观看者。分享者不在线时退回，由观看者稍后重发
      if (!this.openPeer(body.peer)) return json({ error: 'unknown_peer' }, 403);
      if (!this.live('host').length) return json({ error: 'no_host' }, 404);
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

  toPeers(msg) {
    for (const ws of this.live('peer')) send(ws, msg);
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

  turnConfigured() {
    const { TURN_KEY_ID, TURN_KEY_API_TOKEN, ICE_SERVERS } = this.env;
    return Boolean(TURN_KEY_ID && TURN_KEY_API_TOKEN && !ICE_SERVERS);
  }

  /** 生成这次分享专用的 TURN 临时凭证。没配置 TURN 密钥、用 ICE_SERVERS 覆盖或接口两次都出错时只用 STUN。 */
  async issueIceServers() {
    if (!this.turnConfigured()) return this.iceServers();
    const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: apiToken } = this.env;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${TURN_API}/${keyId}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL_S }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const relays = (await res.json()).iceServers
          .filter((s) => s.username)
          .map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => TURN_URL.test(u)) }))
          .filter((s) => s.urls.length);
        if (!relays.length) throw new Error('no usable TURN url');
        return [...DEFAULT_ICE_SERVERS, ...relays];
      } catch (err) {
        console.error(`TURN credentials unavailable (attempt ${attempt}):`, err.message);
        if (attempt >= 2) return this.iceServers();
      }
    }
  }

  /**
   * 开始分享时没领到中转凭证（接口偶尔出错），有人连上来时再领一次，领到后发给所有人。
   * 否则整场分享都没有中转，校园网、手机网络之间会一直连不上。
   */
  async ensureRelay(meta) {
    if (!this.turnConfigured() || meta.ice?.some((s) => s.username)) return;
    if (Date.now() - (meta.iceTriedAt ?? 0) < TURN_RETRY_MS) return;
    meta.iceTriedAt = Date.now();
    meta.ice = await this.issueIceServers();
    await this.ctx.storage.put('meta', meta);
    if (!meta.ice.some((s) => s.username)) return;
    for (const ws of this.live()) send(ws, { type: 'ice', ice: meta.ice });
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
