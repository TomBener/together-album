#!/usr/bin/env node
import QRCode from 'qrcode';
import { createApp, DEFAULT_ICE_SERVERS } from './server/app.js';
import { lanAddresses, startTunnel } from './server/network.js';

const port = Number(process.env.PORT ?? 3000);
const wantTunnel = process.argv.includes('--tunnel');
const iceServers = parseIceServers(process.env.ICE_SERVERS);
const app = createApp({ publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || null, iceServers });
let tunnel = null;

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，换一个端口：PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});

app.server.listen(port, process.env.HOST, async () => {
  const rows = [['本机', `http://localhost:${port}`]];
  for (const a of lanAddresses()) rows.push([a.label, `http://${a.address}:${port}`]);
  if (process.env.PUBLIC_URL) rows.unshift(['公网', process.env.PUBLIC_URL]);

  if (wantTunnel) {
    console.log('正在启动 cloudflared 隧道…');
    try {
      tunnel = await startTunnel(port);
      app.setPublicUrl(tunnel.url);
      rows.unshift(['公网', tunnel.url]);
    } catch (err) {
      console.error(`隧道启动失败：${err.message}`);
    }
  }

  const width = Math.max(...rows.map(([label]) => displayWidth(label)));
  console.log('\n  一起翻相册 已启动\n');
  for (const [label, url] of rows) console.log(`  ${label}${' '.repeat(width - displayWidth(label))}  ${url}`);

  const phoneUrl = rows.find(([label]) => label !== '本机')?.[1];
  if (phoneUrl) {
    console.log(`\n  分享者用手机扫这个码打开（${phoneUrl}）：\n`);
    console.log(await QRCode.toString(phoneUrl, { type: 'terminal', small: true }));
  }
  console.log(
    iceServers.length
      ? `  照片走 WebRTC 点对点直传；穿透 NAT 用：${iceServers.flatMap((s) => s.urls).join(', ')}`
      : '  照片走 WebRTC 点对点直传；ICE_SERVERS=[]，只在同一局域网内直连。',
  );
  if (tunnel) console.log('  隧道只转发网页和连接信令，照片不经过它。刚生成的地址可能要等十几秒才能访问。');
  console.log('  按 Ctrl+C 停止，所有会话随之结束。\n');
});

function parseIceServers(raw) {
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return value;
  } catch {
    // 落到下面的提示
  }
  console.error('ICE_SERVERS 需要是 JSON 数组，例如 [] 或 [{"urls":"stun:stun.l.google.com:19302"}]，已改用默认值');
  return DEFAULT_ICE_SERVERS;
}

function displayWidth(text) {
  return [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
}

function shutdown() {
  app.endAll('shutdown');
  tunnel?.proc.kill();
  app.server.close();
  app.server.closeAllConnections();
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
