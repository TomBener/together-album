// 分享者每条连接按这个先后发照片：先发当前这张，再提前发往后两张、往前一张、往后第三张。
// 往后翻最常见，所以多备几张；往回翻一张也常见。提前发的照片是锁着的（seal.js），翻到才能看。

const OFFSETS = [0, 1, 2, -1, 3];

/**
 * 当前在第 index 张、一共 count 张时，按发送先后列出要发的照片序号。
 * ahead 为假（不能加密，没法提前发）时只发当前这张。
 */
export function sendOrder(index, count, ahead = true) {
  if (!Number.isInteger(index) || index < 0 || index >= count) return [];
  const offsets = ahead ? OFFSETS : [0];
  return offsets.map((d) => index + d).filter((i) => i >= 0 && i < count);
}
