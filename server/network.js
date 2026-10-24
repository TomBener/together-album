import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

let hardwarePorts;

// macOS 的网卡名（en0/en1）因机型而异，用系统的“硬件端口”名称（Wi‑Fi、Ethernet）做标签更好认。
function hardwarePortLabels() {
  if (hardwarePorts) return hardwarePorts;
  hardwarePorts = {};
  if (process.platform !== 'darwin') return hardwarePorts;
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 2000 });
    let port = null;
    for (const line of out.split('\n')) {
      const p = line.match(/^Hardware Port: (.+)$/);
      if (p) port = p[1].trim();
      const d = line.match(/^Device: (.+)$/);
      if (d && port) hardwarePorts[d[1].trim()] = port;
    }
  } catch {
    // 拿不到就用网卡名
  }
  return hardwarePorts;
}

function classify(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || a >= 224) return null;
  if (a === 169 && b === 254) return null; // 链路本地
  if (a === 198 && (b === 18 || b === 19)) return null; // Surge / Clash 等代理的虚拟网卡
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  return 'other';
}

function rank(kind, label) {
  if (kind === 'lan') return /wi-?fi|wlan|airport/i.test(label) ? 0 : 1;
  return kind === 'other' ? 2 : 3;
}

/** 本机可被其他设备访问的 IPv4 地址，Wi‑Fi 优先（手机通常连 Wi‑Fi）。 */
export function lanAddresses() {
  const labels = hardwarePortLabels();
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const kind = classify(a.address);
      if (!kind) continue;
      const label = kind === 'tailscale' ? 'Tailscale' : (labels[iface] ?? iface);
      out.push({ address: a.address, label, rank: rank(kind, label) });
    }
  }
  return out.sort((x, y) => x.rank - y.rank);
}

/** 用 cloudflared 开一个临时公网 HTTPS 隧道（无需账号），返回 trycloudflare.com 地址。 */
export function startTunnel(port, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('等待 cloudflared 返回地址超时'));
    }, timeoutMs);
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!m) return;
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      proc.stdout.resume();
      proc.stderr.resume();
      resolve({ url: m[0], proc });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('没有找到 cloudflared，先运行 brew install cloudflared') : err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared 意外退出（code ${code}）`));
    });
  });
}
