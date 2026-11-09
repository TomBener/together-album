// 分享者每条连接按这个先后发照片：先发当前这张，再提前发往后两张、往前一张、往后第三张。
// 往后翻最常见，所以多备几张；往回翻一张也常见。提前发的照片是锁着的（seal.js），翻到才能看。
// 每张先发预览，再发原画质。大一档的原画质（large）只给当前这张，见 sendPlan。

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

/**
 * 按先后列出这条连接还要发的 [照片, 版本]。
 * done：对方已经有的 '照片id:版本'。对方已有原画质或大一档的照片，不再发。
 * need：对方的屏幕全屏看照片时，照片长边要多少像素；direct：两边是直连。
 *
 * 大一档的数据量约是原画质的两倍，所以只给当前这张，而且要对方屏幕比原画质大（Mac、iPad）、两边直连。
 * 它排在下一张的原画质后面：分享者接着往后翻时，下一张已经清楚，不用等它。
 * 中转常常慢，所以提前发的几张都用原画质，翻页才跟得上。
 */
export function sendPlan({ photos, index, done, need = 0, direct = false, ahead = true }) {
  const order = sendOrder(index, photos.length, ahead);
  const has = (photo, kind) => done.has(`${photo.id}:${kind}`);
  const current = photos[index];
  const large = direct && current?.large && need > current.fullEdge && !has(current, 'large');
  const after = order.includes(index + 1) ? index + 1 : index;
  const list = [];
  for (const i of order) {
    const photo = photos[i];
    if (!has(photo, 'full') && !has(photo, 'large')) {
      if (!has(photo, 'preview')) list.push([photo, 'preview']);
      list.push([photo, 'full']);
    }
    if (large && i === after) list.push([current, 'large']);
  }
  return list;
}
