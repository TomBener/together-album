// 提前发给观看者的照片先锁上：每张照片一把钥匙（AES-GCM），分享者翻到哪张，才把那张的钥匙发过去。
// 没翻到的照片，观看者那边只有打不开的数据，分享结束时随页面一起清除。
// 局域网 http 页面没有加密接口（crypto.subtle 只在 HTTPS 和 localhost 下可用），这时不提前发，只发翻到的那张。

export const canSeal = Boolean(globalThis.crypto?.subtle) && globalThis.isSecureContext !== false;

/** 一把新钥匙（16 字节）。 */
export function newSecret() {
  return crypto.getRandomValues(new Uint8Array(16));
}

const importKey = (secret, usage) => crypto.subtle.importKey('raw', secret, 'AES-GCM', false, [usage]);

/** 用 secret 加密 data，返回 { iv, data }。同一把钥匙每次加密都换新的 iv。 */
export async function seal(secret, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(secret, 'encrypt');
  return { iv, data: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)) };
}

/** 解开 seal 的结果。钥匙不对或数据被改过时抛错。 */
export async function unseal(secret, iv, data) {
  const key = await importKey(secret, 'decrypt');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
}

export const toBase64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const fromBase64 = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
