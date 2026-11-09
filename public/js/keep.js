// 分享期间把会话和压缩后的照片暂存在分享者自己的浏览器里，不上传。
// 分享页被关掉或刷新（比如在微信里切回聊天发链接）后再打开，能接着分享，发出去的链接不失效。
//
// 照片加密后才存，钥匙只在服务器上（会话的 keepKey），本机不存。分享结束或过期（分享者离开 1 小时）时
// 服务器删掉钥匙，即使分享者再也不打开这个网站，暂存的照片也再打不开；下次打开时连同记录一起删除。
// 浏览器不让存（无痕模式、空间不够、局域网 http 下没有加密接口）时静默跳过，只是关掉页面后没法接着分享。

const SESSION_KEY = 'together-album:session';
const ENDING_KEY = 'together-album:ending';
const DB_NAME = 'together-album';
const STORE = 'photos';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不了就算了
  }
}

/** 正在进行的分享：{ id, key, createdAt, joinUrls, index, total }。 */
export const loadSession = () => read(SESSION_KEY);
export const saveSession = (session) => write(SESSION_KEY, session);

/** 点了结束、但还没通知到服务器的分享：{ id, key }。下次打开页面时补发。 */
export const pendingEnd = () => read(ENDING_KEY);
export const markEnding = (session) => write(ENDING_KEY, session);
export const clearEnding = () => write(ENDING_KEY, null);

// ---- 加密 ----

let keyReady = Promise.resolve(null);

/** 用服务器给的钥匙（base64url）加解密。没有钥匙或浏览器不支持时，照片不暂存。 */
export function useKey(raw) {
  keyReady = (async () => {
    if (!raw || !globalThis.crypto?.subtle) return null;
    try {
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch {
      return null;
    }
  })();
  return keyReady;
}

async function seal(key, blob) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer());
  return { iv, data, type: blob.type };
}

async function unseal(key, { iv, data, type }) {
  return new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)], { type });
}

// ---- 照片库（IndexedDB） ----

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 在一个事务里操作照片库，事务提交后返回 fn 发出的请求的结果。 */
async function run(mode, fn) {
  const tx = (await db()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const recordKey = (sessionId, index) => `${sessionId}:${String(index).padStart(3, '0')}`;

/**
 * 暂存一张处理好的照片。index 是它在分享里的顺序，恢复时按它排序。
 * id 一起存下：恢复后照片 id 不变，观看者已经收到的照片不用重发。
 */
export async function savePhoto(sessionId, index, { id, full, preview, thumb }) {
  const key = await keyReady;
  if (!key) return;
  try {
    const record = {
      sessionId,
      index,
      photoId: id,
      full: await seal(key, full),
      preview: preview ? await seal(key, preview) : null,
      thumb: await seal(key, thumb),
    };
    await run('readwrite', (store) => store.put(record, recordKey(sessionId, index)));
  } catch {
    // 空间不够等：这张不暂存，重新打开时提示分享者补上
  }
}

/**
 * 取回某次分享暂存的照片：{ index, id, full, preview, thumb }，按顺序排好。
 * 旧版本存的记录没有 id 和 preview，这时它们为 null。
 * 只要从第一张起连续的那些；中间缺了一张时，后面的也不要，免得重新添加的照片和旧照片错位。
 */
export async function loadPhotos(sessionId) {
  const key = await keyReady;
  if (!key) return [];
  let records;
  try {
    records = (await run('readonly', (store) => store.getAll()))
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
  const photos = [];
  for (const r of records) {
    if (r.index !== photos.length) break;
    let full, thumb;
    try {
      full = await unseal(key, r.full);
      thumb = await unseal(key, r.thumb);
    } catch {
      break; // 钥匙对不上或数据损坏：从这张起当作没有暂存
    }
    // 预览可以重新生成，解不开时不影响这张照片
    const preview = r.preview ? await unseal(key, r.preview).catch(() => null) : null;
    photos.push({ index: r.index, id: r.photoId ?? null, full, preview, thumb });
  }
  const stale = records.filter((r) => r.index >= photos.length).map((r) => recordKey(sessionId, r.index));
  if (stale.length) run('readwrite', (store) => stale.forEach((k) => store.delete(k))).catch(() => {});
  return photos;
}

/** 删除会话记录和所有暂存的照片。 */
export function forget() {
  write(SESSION_KEY, null);
  return run('readwrite', (store) => store.clear()).catch(() => {});
}
