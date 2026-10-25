// 界面文字。按浏览器的语言偏好依次找中文或英文，都没有时用英文。
// 页面里的静态文字用 data-i18n（文字）、data-i18n-label（aria-label）、data-i18n-alt（alt）标出键名，由 localize() 填上。

const zh = {
  appName: '一起翻相册',
  lede: '挑几张照片，朋友扫码就能在自己的屏幕上和你同步翻看，不用把手机递过去。不在身边的话，发个链接也行。',
  pick: '选择照片，开始分享',
  promiseEncrypted: '全程加密',
  promiseEncryptedMore: '，不保存任何照片',
  promiseOnlyShown: '你翻到哪张，朋友才收到哪张',
  promiseOnlyShownMore: '，其余照片不会离开你的手机',
  promiseEnd: '随时结束',
  promiseEndMore: '，朋友屏幕上的照片立即清除',
  invite: '邀请',
  end: '结束',
  fullscreen: '全屏',
  prev: '上一张',
  next: '下一张',
  addPhotos: '添加照片',
  inviteTitle: '让朋友扫码加入',
  inviteSub: '用相机扫一扫，浏览器里直接打开，不用装 App；朋友不在身边的话，把下面的链接发过去。分享时请让本页面留在前台。',
  qrAlt: '加入分享的二维码',
  addrSwitch: '二维码使用的地址',
  joinLink: '加入链接',
  copy: '复制',
  start: '开始翻看',
  confirmTitle: '结束这次分享？',
  confirmSub: '朋友屏幕上的照片会立即清除，链接随之失效。',
  confirmCancel: '再看看',
  confirmOk: '结束分享',

  connecting: '正在连接…',
  watching: (n) => `${n} 人在看`,
  joined: (n) => `又有人加入了，现在 ${n} 人在看`,
  connectHint: '还没连上。开着 VPN 的话，请先暂时关闭；在一起时，也可以连同一个 Wi‑Fi 或对方手机的热点。',
  networkLater: '网络不太好，请稍后再试',
  networkRetry: '网络不太好，请重试',
  lastPhoto: '已经是最后一张了',
  firstPhoto: '已经是第一张了',
  shareEnded: '分享已结束',

  // 分享者
  reloadEnded: '页面刷新后，上一次分享已结束',
  endedSelf: '朋友屏幕上的照片已经清除，链接也已失效。',
  endedExpired: '分享时间过长或离开太久，已自动结束。',
  endedGone: '这次分享已经结束，朋友屏幕上的照片已经清除。',
  shareAgain: '再分享一组',
  tooMany: (max, extra) => `一次最多分享 ${max} 张，多出的 ${extra} 张没有加入`,
  preparingThumb: '正在准备',
  photoN: (n) => `第 ${n} 张`,
  unreadable: (n) => `有 ${n} 张照片无法读取，已跳过`,
  nextPreparing: '后面的照片还在准备中',
  reconnecting: '连接中断，正在重连…',
  friendConnecting: '朋友正在连接…',
  waitingFriends: '等待朋友加入',
  friendJoinedTouch: '朋友已连上 · 左右滑动翻页',
  friendJoinedMouse: '朋友已连上，用方向键或点两侧翻页',
  preparingCount: (n) => `正在准备 ${n} 张`,
  preparingPhotos: '正在准备照片…',
  hintPublic: '开着 VPN 的话请先关掉；在一起时连同一个 Wi‑Fi 最流畅。',
  hintTailscale: '这是 Tailscale 地址，只有登录了你的 Tailscale 的设备能打开。',
  hintLan: '朋友需要和你连同一个 Wi‑Fi。打不开的话换个地址，或用 npm run tunnel 启动公网模式。',
  processing: (done, total) => `正在处理照片 ${done} / ${total}`,
  swipeHint: '左右滑动，或点按屏幕两侧翻页',
  airdrop: '用隔空投送发给朋友',
  sendLink: '发送链接',
  shareFailed: '没能打开分享，请复制链接发给朋友',
  copied: '链接已复制',
  copyFailed: '复制失败，请长按链接手动复制',
  addrPublic: '公网',
  addrCurrent: '当前地址',
  addrLocal: '本机',

  // 观看者
  lookBackTouch: '左右滑动可以回看之前的照片',
  lookBackKeys: '用方向键可以回看之前的照片',
  laterNotYet: '后面的照片等对方翻到再看',
  earlierNotYet: '前面的照片对方还没翻到',
  linkGone: '链接已失效',
  linkGoneText: '这次分享已经结束，或者链接不完整。请让对方重新给你二维码。',
  clearedHere: '照片已从这台设备上清除。',
  receiving: (p) => `正在接收 ${p}`,
  live: '实时同步',
  unstable: '连接不稳，正在重连…',
  retrying: '连接中断，正在重试…',
  backToLive: (n) => `回到同步 · 第 ${n} 张`,
  receivingPhoto: (p) => `正在接收照片 ${p}`,
  waitingFirst: '已连上，等对方翻开第一张照片…',
  connectingPeer: '正在连接对方…',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const en = {
  appName: 'Together Album',
  lede: 'Pick a few photos, and friends scan a code to flip through them with you on their own screens. No passing your phone around. Not in the same room? Just send them the link.',
  pick: 'Choose photos to share',
  promiseEncrypted: 'Encrypted end to end',
  promiseEncryptedMore: ', and no photo is ever stored',
  promiseOnlyShown: 'Friends only get the photo you’re on',
  promiseOnlyShownMore: '; the rest never leave your phone',
  promiseEnd: 'End anytime',
  promiseEndMore: ', and the photos vanish from their screens',
  invite: 'Invite',
  end: 'End',
  fullscreen: 'Full screen',
  prev: 'Previous photo',
  next: 'Next photo',
  addPhotos: 'Add photos',
  inviteTitle: 'Scan to join',
  inviteSub: 'Friends just point their camera at the code and it opens in the browser, no app needed. Not nearby? Send them the link below. Keep this page open while you share.',
  qrAlt: 'QR code for joining',
  addrSwitch: 'Address in the QR code',
  joinLink: 'Join link',
  copy: 'Copy',
  start: 'Start',
  confirmTitle: 'End this share?',
  confirmSub: 'The photos disappear from your friends’ screens right away, and the link stops working.',
  confirmCancel: 'Keep sharing',
  confirmOk: 'End share',

  connecting: 'Connecting…',
  watching: (n) => `${n} watching`,
  joined: (n) => `Someone joined. ${n} watching now`,
  connectHint: 'Still not connected. If you’re on a VPN, turn it off for now. When you’re together, you can also join the same Wi‑Fi or the other phone’s hotspot.',
  networkLater: 'Network trouble. Please try again later',
  networkRetry: 'Network trouble. Please try again',
  lastPhoto: 'That’s the last photo',
  firstPhoto: 'That’s the first photo',
  shareEnded: 'Share ended',

  reloadEnded: 'Reloading the page ended your last share',
  endedSelf: 'The photos are gone from your friends’ screens, and the link no longer works.',
  endedExpired: 'The share ran too long or you were away too long, so it ended on its own.',
  endedGone: 'This share has ended, and the photos are gone from your friends’ screens.',
  shareAgain: 'Share more photos',
  tooMany: (max, extra) => `You can share up to ${max} photos at a time. ${plural(extra, 'photo was', 'photos were')} left out`,
  preparingThumb: 'Preparing',
  photoN: (n) => `Photo ${n}`,
  unreadable: (n) => `Skipped ${plural(n, 'photo', 'photos')} that couldn’t be read`,
  nextPreparing: 'The next photos are still being prepared',
  reconnecting: 'Reconnecting…',
  friendConnecting: 'Friend connecting…',
  waitingFriends: 'Waiting for friends',
  friendJoinedTouch: 'Friend connected · Swipe to flip',
  friendJoinedMouse: 'Friend connected. Use the arrow keys or click the sides to flip',
  preparingCount: (n) => `Preparing ${plural(n, 'photo', 'photos')}`,
  preparingPhotos: 'Preparing photos…',
  hintPublic: 'Turn off any VPN first. When you’re together, the same Wi‑Fi works best.',
  hintTailscale: 'This is a Tailscale address. Only devices signed in to your Tailscale can open it.',
  hintLan: 'Your friend needs to be on the same Wi‑Fi. If it won’t open, try another address, or start public mode with npm run tunnel.',
  processing: (done, total) => `Processing photos ${done} / ${total}`,
  swipeHint: 'Swipe, or tap either side of the screen, to flip',
  airdrop: 'Send with AirDrop',
  sendLink: 'Send link',
  shareFailed: 'Couldn’t open sharing. Copy the link and send it instead',
  copied: 'Link copied',
  copyFailed: 'Couldn’t copy. Press and hold the link to copy it',
  addrPublic: 'Public',
  addrCurrent: 'This address',
  addrLocal: 'This device',

  lookBackTouch: 'Swipe to look back at earlier photos',
  lookBackKeys: 'Use the arrow keys to look back at earlier photos',
  laterNotYet: 'You’ll see the next photo when the sharer gets there',
  earlierNotYet: 'The sharer hasn’t shown the earlier photos yet',
  linkGone: 'Link expired',
  linkGoneText: 'This share has ended, or the link is incomplete. Ask the sharer for a new QR code.',
  clearedHere: 'The photos have been cleared from this device.',
  receiving: (p) => `Receiving ${p}`,
  live: 'Live',
  unstable: 'Unstable, reconnecting…',
  retrying: 'Disconnected, retrying…',
  backToLive: (n) => `Back to live · Photo ${n}`,
  receivingPhoto: (p) => `Receiving photo ${p}`,
  waitingFirst: 'Connected. Waiting for the first photo…',
  connectingPeer: 'Connecting to the sharer…',
};

function pickLang() {
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    if (/^zh\b/i.test(tag)) return 'zh';
    if (/^en\b/i.test(tag)) return 'en';
  }
  return 'en';
}

export const lang = pickLang();
const strings = lang === 'zh' ? zh : en;

export function t(key, ...args) {
  const s = strings[key];
  return typeof s === 'function' ? s(...args) : (s ?? key);
}

export function localize() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('appName');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  for (const el of document.querySelectorAll('[data-i18n-alt]')) el.alt = t(el.dataset.i18nAlt);
}
