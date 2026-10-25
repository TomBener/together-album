import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { lanAddresses } from './network.js';

// 服务器只做“信令”：帮两端交换建立 WebRTC 直连所需的连接信息（SDP、ICE 候选）。
// 照片从分享者的浏览器经加密数据通道直接发到观看者，不经过这里，也不落盘。

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export const DEFAULT_LIMITS = {
  sessions: 500,
  viewersPerSession: 12,
  signalBytes: 64 * 1024,
  hostAwayMs: 60 * 60 * 1000, // 分享者离线超过 1 小时自动结束
  maxAgeMs: 6 * 60 * 60 * 1000, // 无论如何 6 小时后结束
};

// STUN 只用来让设备知道自己的公网地址，不经手照片。设成 [] 则只走局域网直连。
export const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

const HEARTBEAT_MS = 20_000; // 低于 Cloudflare 的 100 秒空闲断流，也用来清理掉线的连接
const SWEEP_MS = 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const BASE_HEADERS = {
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
const PEER_ID = /^[\w-]{16,64}$/;

const token = (bytes) => randomBytes(bytes).toString('base64url');
const short = (id) => id.slice(0, 6);

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export function createApp({
  publicUrl = null,
  iceServers = DEFAULT_ICE_SERVERS,
  limits = DEFAULT_LIMITS,
  log = console.log,
} = {}) {
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJSON(res, err.status, { error: err.message });
      log('[错误]', err);
      sendJSON(res, 500, { error: 'internal' });
    });
  });

  server.on('upgrade', handleUpgrade);

  const heartbeat = setInterval(() => {
    for (const s of sessions.values()) {
      for (const c of clientsOf(s)) {
        if (!c.alive) {
          c.ws.terminate(); // 上一轮的 ping 没有回应，当作掉线
          continue;
        }
        c.alive = false;
        c.ws.ping();
        push(c, { type: 'ping' }); // 让浏览器端也能发现连接僵死
      }
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(sweep, SWEEP_MS);
  heartbeat.unref();
  sweeper.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    wss.close();
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    if (pathname === '/healthz') return sendText(res, 200, 'ok');
    if (pathname === '/' || VIEWER_PAGE.test(pathname)) return serveStatic(req, res, '/index.html');
    return serveStatic(req, res, pathname);
  }

  async function handleApi(req, res, url) {
    // /api/sessions[/:id[/:action]]
    const [, , collection, id, action, ...rest] = url.pathname.split('/');
    if (collection !== 'sessions' || rest.length) throw new HttpError(404, 'not_found');
    const { method } = req;

    if (!id) {
      if (method === 'POST') return createSession(req, res);
      throw new HttpError(405, 'method_not_allowed');
    }

    const s = sessions.get(id);
    if (!s) throw new HttpError(404, 'not_found');
    const host = isHost(req, url, s);

    if (!action && method === 'GET') return sendJSON(res, 200, { ok: true });
    if (!action && method === 'DELETE') {
      if (!host) throw new HttpError(401, 'unauthorized');
      endSession(s, 'host');
      return sendJSON(res, 200, { ok: true });
    }
    if (action === 'signal' && method === 'POST') return relaySignal(req, res, s, host);
    if (action === 'qr' && method === 'GET') return serveQr(res, s, url);
    throw new HttpError(404, 'not_found');
  }

  // ---- 会话 ----

  function createSession(req, res) {
    if (sessions.size >= limits.sessions) throw new HttpError(503, 'busy');
    const id = token(16);
    const now = Date.now();
    const s = {
      id,
      hostKey: token(24),
      joinUrls: joinUrlsFor(req, id),
      hosts: new Set(),
      peers: new Map(), // 观看者自己生成的 peerId → WebSocket 连接
      qr: new Map(),
      createdAt: now,
      hostSeenAt: now,
    };
    sessions.set(id, s);
    log(`[创建] ${short(id)}  当前 ${sessions.size} 个会话`);
    sendJSON(res, 201, { id, hostKey: s.hostKey, joinUrls: s.joinUrls, ice: iceServers });
  }

  function endSession(s, reason) {
    if (sessions.get(s.id) !== s) return;
    sessions.delete(s.id);
    for (const c of clientsOf(s)) {
      push(c, { type: 'ended', reason });
      c.ws.close(4000, 'ended');
    }
    s.hosts.clear();
    s.peers.clear();
    s.qr.clear();
    log(`[结束] ${short(s.id)}  原因：${reason}`);
  }

  function sweep() {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.hosts.size) s.hostSeenAt = now;
      if (now - s.createdAt > limits.maxAgeMs) endSession(s, 'expired');
      else if (now - s.hostSeenAt > limits.hostAwayMs) endSession(s, 'host_away');
    }
  }

  function isHost(req, url, s) {
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key');
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(s.hostKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- 实时通道（WebSocket）与信令转发 ----
  // 推送用 WebSocket 而不是 SSE：Cloudflare 的临时隧道会把 SSE 整个缓冲住，WebSocket 不会。

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const reject = (status) =>
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const url = new URL(req.url, 'http://localhost');
    const [, api, collection, id, action, ...rest] = url.pathname.split('/');
    if (api !== 'api' || collection !== 'sessions' || action !== 'live' || rest.length) return reject(404);
    const s = sessions.get(id);
    if (!s) return reject(404);
    if (!sameOrigin(req)) return reject(403);

    const host = isHost(req, url, s);
    const peerId = host ? null : url.searchParams.get('peer');
    if (!host && !PEER_ID.test(peerId ?? '')) return reject(400);
    if (!host && !s.peers.has(peerId) && s.peers.size >= limits.viewersPerSession) return reject(429);
    wss.handleUpgrade(req, socket, head, (ws) => attachLive(ws, s, host, peerId));
  }

  function sameOrigin(req) {
    const { origin } = req.headers;
    if (!origin) return true; // 非浏览器客户端
    try {
      const { host } = new URL(origin);
      return host === req.headers.host || (publicUrl && host === new URL(publicUrl).host);
    } catch {
      return false;
    }
  }

  function attachLive(ws, s, host, peerId) {
    const client = { ws, alive: true };
    ws.on('pong', () => (client.alive = true));
    ws.on('error', () => {});
    if (sessions.get(s.id) !== s) return ws.close(4000, 'ended');

    if (host) {
      s.hosts.add(client);
      s.hostSeenAt = Date.now();
      // 分享者（重新）连上时拿到完整名单，自行补连还没直连上的观看者
      push(client, { type: 'hello', peers: [...s.peers.keys()], joinUrls: s.joinUrls });
      ws.on('close', () => {
        if (s.hosts.delete(client)) s.hostSeenAt = Date.now();
      });
      return;
    }

    // 同一页面断线重连会带着同一个 peerId 回来，替换旧连接而不是算作新观看者
    const previous = s.peers.get(peerId);
    s.peers.set(peerId, client);
    previous?.ws.close(4001, 'replaced');
    push(client, { type: 'welcome', peerId, ice: iceServers });
    toHosts(s, { type: 'peer-join', peerId });
    ws.on('close', () => {
      if (s.peers.get(peerId) !== client) return;
      s.peers.delete(peerId);
      toHosts(s, { type: 'peer-leave', peerId });
    });
  }

  async function relaySignal(req, res, s, host) {
    let body;
    try {
      body = JSON.parse((await readBody(req, limits.signalBytes)).toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad_json');
    }
    if (typeof body?.data !== 'object' || body.data === null) throw new HttpError(400, 'bad_signal');
    if (sessions.get(s.id) !== s) throw new HttpError(404, 'not_found');

    if (host) {
      // 分享者 → 某位观看者
      const target = s.peers.get(body.to);
      if (!target) throw new HttpError(404, 'no_peer');
      push(target, { type: 'signal', data: body.data });
      s.hostSeenAt = Date.now();
    } else {
      // 观看者 → 分享者：必须是当前在线的观看者，分享者不在线时直接丢弃，对方会重试
      if (!s.peers.has(body.peer)) throw new HttpError(403, 'unknown_peer');
      toHosts(s, { type: 'signal', from: body.peer, data: body.data });
    }
    sendJSON(res, 202, { ok: true });
  }

  function push(client, msg) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  function toHosts(s, msg) {
    for (const c of s.hosts) push(c, msg);
  }

  function clientsOf(s) {
    return [...s.hosts, ...s.peers.values()];
  }

  // ---- 加入链接与二维码 ----

  function joinUrlsFor(req, id) {
    const bases = [];
    // kind 给界面选显示的名称（public、current、local 按界面语言翻译）；网卡地址另带网卡名 label
    const add = (kind, label, origin) => {
      if (origin && !bases.some((b) => b.origin === origin)) bases.push({ kind, label, origin });
    };
    const lan = lanAddresses();
    if (publicUrl) add('public', undefined, publicUrl);
    const origin = requestOrigin(req);
    if (origin && !isLoopback(origin)) {
      const { hostname } = new URL(origin);
      const match = lan.find((a) => a.address === hostname);
      add(match?.kind ?? 'current', match?.label, origin);
    }
    const port = server.address()?.port;
    for (const a of lan) add(a.kind, a.label, `http://${a.address}:${port}`);
    if (!bases.length && origin) add('local', undefined, origin); // 没有联网时至少能在本机测试
    return bases.map((b) => ({ kind: b.kind, label: b.label, url: `${b.origin}/v/${id}` }));
  }

  async function serveQr(res, s, url) {
    const i = Number(url.searchParams.get('u') ?? 0);
    const entry = s.joinUrls[i];
    if (!entry) throw new HttpError(404, 'not_found');
    let svg = s.qr.get(i);
    if (!svg) {
      svg = await QRCode.toString(entry.url, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
        color: { dark: '#111111', light: '#ffffff' },
      });
      s.qr.set(i, svg);
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store' });
    res.end(svg);
  }

  // ---- 静态文件 ----

  async function serveStatic(req, res, pathname) {
    let file;
    try {
      file = path.join(PUBLIC_DIR, decodeURIComponent(pathname));
    } catch {
      throw new HttpError(400, 'bad_path');
    }
    const type = MIME[path.extname(file)];
    if (!file.startsWith(PUBLIC_DIR) || !type) throw new HttpError(404, 'not_found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'not_found');
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  return {
    server,
    sessions,
    setPublicUrl(url) {
      publicUrl = url;
    },
    endAll(reason) {
      for (const s of [...sessions.values()]) endSession(s, reason);
    },
  };
}

// ---- 工具函数 ----

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return reject(new HttpError(413, 'too_large'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, 'too_large'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestOrigin(req) {
  const host = req.headers.host;
  if (!host || !/^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/i.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

function isLoopback(origin) {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || hostname.startsWith('127.');
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
