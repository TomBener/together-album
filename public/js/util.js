export const $ = (selector) => document.querySelector(selector);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 连了这么久还没连上，就给两端看怎么解决（i18n 的 connectHint）。开着 VPN 或网络不允许设备互连时直连会失败
export const STALL_MS = 8000;

export function showView(id) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== id;
}

let toastTimer;
export function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

export function showNotice({ title, text, action = null }) {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  const link = $('#notice-action');
  link.hidden = !action;
  if (action) {
    link.textContent = action.label;
    link.href = action.href;
  }
  showView('notice');
}

/** fetch 的薄封装：带上分享者密钥、解析 JSON，非 2xx 时抛出带 status 的错误。 */
export async function api(path, { method = 'GET', key, json, body, type } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (type) {
    headers['Content-Type'] = type;
  }
  const res = await fetch(path, { method, headers, body, cache: 'no-store' });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

/** 看照片时保持屏幕常亮。只在 HTTPS（如隧道模式）下可用，局域网 http 下静默跳过。 */
export function keepScreenOn() {
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  const request = async () => {
    if (lock || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      // 省电模式等情况下会被拒绝，不影响使用
    }
  };
  document.addEventListener('visibilitychange', request);
  request();
}

export async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 局域网 http 下没有剪贴板 API，退回到选中文本
    input.focus();
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}
