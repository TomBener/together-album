import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

let app;
let base;

before(async () => {
  app = createApp({ log: () => {}, iceServers: [] });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.endAll('test');
  app.server.closeAllConnections();
  app.server.close();
});

const post = (path, body, key) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 连上实时通道：next(type) 等待下一条指定类型的消息；status 是握手结果（101 或拒绝时的状态码）。 */
function listen(path, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, options);
    const queue = [];
    const waiters = [];
    const deliver = (msg) => {
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    const api = (status) => ({
      status,
      next(type, ms = 2000) {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((ok, fail) => {
          waiters.push({ type, resolve: ok });
          setTimeout(() => fail(new Error(`等待 ${type} 超时`)), ms).unref();
        });
      },
      close: () => ws.close(),
    });
    ws.on('message', (data) => deliver(JSON.parse(data)));
    ws.on('close', (code) => deliver({ type: '__closed', code }));
    ws.on('open', () => resolve(api(101)));
    ws.on('unexpected-response', (req, res) => {
      res.resume();
      resolve(api(res.statusCode));
    });
    ws.on('error', () => {});
  });
}

test('完整流程：创建 → 加入 → 交换信令 → 结束', async () => {
  const created = await post('/api/sessions');
  assert.equal(created.status, 201);
  const { id, hostKey, joinUrls, ice } = await created.json();
  assert.match(id, /^[\w-]{22}$/);
  assert.ok(joinUrls.length >= 1 && joinUrls.every((j) => j.url.endsWith(`/v/${id}`)));
  assert.deepEqual(ice, []);

  const host = await listen(`/api/sessions/${id}/live?key=${hostKey}`);
  assert.deepEqual((await host.next('hello')).peers, []);

  const peer = 'viewer-aaaaaaaaaaaaaaaa';
  const viewer = await listen(`/api/sessions/${id}/live?peer=${peer}`);
  assert.equal((await viewer.next('welcome')).peerId, peer);
  assert.equal((await host.next('peer-join')).peerId, peer);

  // 分享者 → 观看者
  const offer = { link: 'l1', sdp: { type: 'offer', sdp: 'v=0' } };
  assert.equal((await post(`/api/sessions/${id}/signal`, { to: peer, data: offer }, hostKey)).status, 202);
  assert.deepEqual((await viewer.next('signal')).data, offer);

  // 观看者 → 分享者
  const answer = { link: 'l1', sdp: { type: 'answer', sdp: 'v=0' } };
  assert.equal((await post(`/api/sessions/${id}/signal`, { peer, data: answer })).status, 202);
  const relayed = await host.next('signal');
  assert.equal(relayed.from, peer);
  assert.deepEqual(relayed.data, answer);

  // 观看者离开
  viewer.close();
  assert.equal((await host.next('peer-leave')).peerId, peer);

  // 结束会话：所有人收到 ended，之后一切请求 404
  const viewer2 = await listen(`/api/sessions/${id}/live?peer=viewer-bbbbbbbbbbbbbbbb`);
  await viewer2.next('welcome');
  const ended = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${hostKey}` } });
  assert.equal(ended.status, 200);
  assert.equal((await viewer2.next('ended')).reason, 'host');
  assert.equal((await host.next('ended')).reason, 'host');
  assert.equal((await fetch(`${base}/api/sessions/${id}`)).status, 404);
  assert.equal((await viewer2.next('__closed')).code, 4000);
  assert.equal((await listen(`/api/sessions/${id}/live?peer=viewer-cccccccccccccccc`)).status, 404);
});

test('权限：没有密钥不能冒充分享者，陌生观看者不能发信令', async () => {
  const { id, hostKey } = await (await post('/api/sessions')).json();
  const peer = 'viewer-dddddddddddddddd';
  const viewer = await listen(`/api/sessions/${id}/live?peer=${peer}`);
  await viewer.next('welcome');

  // 观看者伪造 to 字段也只能发给分享者，不能发给别的观看者
  assert.equal((await post(`/api/sessions/${id}/signal`, { to: peer, data: {} })).status, 403);
  assert.equal((await post(`/api/sessions/${id}/signal`, { peer: 'viewer-not-connected-xx', data: {} })).status, 403);
  assert.equal((await post(`/api/sessions/${id}/signal`, { to: peer, data: {} }, 'wrong-key')).status, 403);
  assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await listen(`/api/sessions/${id}/live?peer=bad`)).status, 400);
  // 别的网站的页面不能连上来
  const foreign = await listen(`/api/sessions/${id}/live?peer=viewer-ffffffffffffffff`, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await post(`/api/sessions/${id}/signal`, { to: peer, data: {} }, hostKey)).status, 202);
  viewer.close();
});

test('同一观看者断线重连：替换旧连接，不重复计数', async () => {
  const { id, hostKey } = await (await post('/api/sessions')).json();
  const host = await listen(`/api/sessions/${id}/live?key=${hostKey}`);
  await host.next('hello');
  const peer = 'viewer-eeeeeeeeeeeeeeee';
  const first = await listen(`/api/sessions/${id}/live?peer=${peer}`);
  await first.next('welcome');
  await host.next('peer-join');
  const second = await listen(`/api/sessions/${id}/live?peer=${peer}`);
  await second.next('welcome');
  await host.next('peer-join');
  assert.equal((await first.next('__closed')).code, 4001);
  assert.equal(app.sessions.get(id).peers.size, 1);
  // 旧连接关闭不应让分享者以为观看者离开了
  await assert.rejects(host.next('peer-leave', 300));
  second.close();
});

test('页面与二维码', async () => {
  const { id } = await (await post('/api/sessions')).json();
  const page = await fetch(`${base}/v/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const qr = await fetch(`${base}/api/sessions/${id}/qr?u=0`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.match(await qr.text(), /^<svg/);
  assert.equal((await fetch(`${base}/../server/app.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});
