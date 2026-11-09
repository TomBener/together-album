// 界面文字。网址带 ?lang=en 或 ?lang=zh 时用指定的语言；否则按浏览器的语言偏好依次找中文或英文，都没有时用英文。
// 页面里的静态文字用 data-i18n（文字）、data-i18n-label（aria-label）、data-i18n-alt（alt）标出键名，由 localize() 填上。

const zh = {
  appName: '一起翻相册',
  lede: '挑几张照片，朋友扫码就能在自己的屏幕上和你同步翻看，不用把手机递过去。不在身边的话，发个链接也行。',
  pick: '选择照片，开始分享',
  promiseEncrypted: '全程加密',
  promiseEncryptedMore: '，服务器不保存任何照片',
  promiseOnlyShown: '你翻到哪张，朋友才能看到哪张',
  promiseOnlyShownMore: '，后面几张会提前加密送到，没翻到就打不开',
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

  faqTitle: '常见问题',
  faq1q: '照片会上传到服务器吗？',
  faq1a: '不会。照片在你的手机上压缩、去掉位置信息，再加密直接发到朋友的设备上。两台设备直连不通时经 Cloudflare 中转，中转只转发加密后的数据，看不到照片，也不保存。',
  faq2q: '关掉分享页，分享会结束吗？',
  faq2a: '不会马上结束。朋友那边照片照常显示，状态栏显示“对方暂时离开”。1 小时内重新打开本网站，可以接着分享，链接不变。超过 1 小时没回来，分享自动结束。要马上结束，请点右上角的“结束”。',
  faq3q: '照片会留在我的手机浏览器里吗？',
  faq3a: '分享期间，压缩后的照片加密暂存在你的浏览器里，这样关掉页面后还能接着分享。点“结束”时立即删除。分享自动结束时，解密用的钥匙在服务器上删除，这些数据再也打不开，下次打开本网站时一并清除。',
  faq4q: '朋友那边会留下照片吗？',
  faq4a: '照片只在朋友打开的页面里显示，不能长按保存。分享结束后，朋友设备上的照片立即清除。截图和拍屏防不住。',
  faq5q: '为什么连不上，或者照片出来得慢？',
  faq5a: '两台设备能直连时最快。开着 VPN，或者在校园网、手机网络里时，常常要经服务器中转。中转时先显示一张小图，清楚的随后换上。暂时关掉 VPN 通常会快一些。',
  faq6q: '朋友会提前收到我还没翻到的照片吗？',
  sourceCode: '源代码（GitHub）',
  faq6a: '会提前收到后面两三张，但打不开。为了翻页不用等，后面几张会先加密发过去。你翻到哪张，朋友才能打开哪张。没翻到的照片，分享结束时一起清除。',

  connecting: '正在连接…',
  watching: (n) => `${n} 人在看`,
  joined: (n) => `又有人加入了，现在 ${n} 人在看`,
  connectHint: '还没连上，正在继续尝试。开着 VPN 的话，可以先暂时关闭；也可以换个网络再试。',
  relayed: '中转',
  networkLater: '网络不太好，请稍后再试',
  lastPhoto: '已经是最后一张了',
  firstPhoto: '已经是第一张了',
  shareEnded: '分享已结束',

  // 分享者
  lastShareEnded: '上一次分享已经结束',
  resuming: '正在恢复刚才的分享…',
  resumed: '已回到刚才的分享，链接不变',
  resumedMissing: (n) => `已回到刚才的分享，链接不变。有 ${n} 张照片没来得及保存，请点 + 重新添加`,
  pickToContinue: '点下方的 + 选择照片，接着分享。链接不变。',
  handedOff: '已在另一个页面继续',
  handedOffText: '这次分享已经在另一个页面里继续，这个页面可以关掉了。',
  endedSelf: '朋友屏幕上的照片已经清除，链接也已失效。',
  endedExpired: '你离开分享页超过 1 小时，或者分享已满 6 小时，分享已自动结束。',
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
  friendAway: '朋友暂时离开',
  friendJoinedTouch: '朋友已连上 · 左右滑动翻页',
  friendJoinedMouse: '朋友已连上，用方向键或点两侧翻页',
  preparingCount: (n) => `正在准备 ${n} 张`,
  preparingPhotos: '正在准备照片…',
  hintPublic: '暂时关掉 VPN，翻看最流畅。',
  hintWeChat: '在微信里分享：把链接发给朋友后，再点一次你打开本页的那个链接，就能接着翻，链接不会失效。',
  hintTailscale: '这是 Tailscale 地址，只有登录了你的 Tailscale 的设备能打开。',
  hintLan: '朋友需要和你连同一个 Wi‑Fi。打不开的话换个地址，或用 npm run tunnel 启动公网模式。',
  processing: (done, total) => `正在处理照片 ${done} / ${total}，处理完前请留在本页`,
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
  linkGoneText: '对方已经结束了这次分享，或者链接不完整。请让对方重新发一个链接。',
  clearedHere: '照片已从这台设备上清除。',
  backHome: '回到首页',
  hostAway: '对方暂时离开',
  hostAwayText: '对方暂时离开了分享页面。对方回来后，这里会自动继续。',
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
  promiseEncryptedMore: ', and no server ever keeps your photos',
  promiseOnlyShown: 'Friends only see the photo you’re on',
  promiseOnlyShownMore: '; the next few arrive early but stay locked until you get there',
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

  faqTitle: 'Questions',
  faq1q: 'Are my photos uploaded to a server?',
  faq1a: 'No. Your phone shrinks each photo, removes its location data, and sends it encrypted straight to your friends’ devices. If the two devices can’t reach each other, the data goes through a Cloudflare relay. The relay only passes along encrypted data. It can’t see your photos and doesn’t keep them.',
  faq2q: 'Does closing the page end the share?',
  faq2a: 'Not right away. Your friends still see the photos, and their status bar says you stepped away. Open this site again within an hour to pick up where you left off, with the same link. If you don’t come back within an hour, the share ends on its own. To end it right away, tap End at the top right.',
  faq3q: 'Do my photos stay in my browser?',
  faq3a: 'While you share, the shrunken photos are stored encrypted in your browser, so you can pick up after closing the page. Tapping End deletes them right away. When a share ends on its own, the server deletes the key that unlocks them, so the data can never be opened again. It’s cleared the next time you open this site.',
  faq4q: 'Do the photos stay on my friends’ devices?',
  faq4a: 'Photos only show inside the page your friends opened, and they can’t be saved by pressing and holding. When the share ends, the photos are cleared from their devices right away. Screenshots and photos of the screen can’t be prevented.',
  faq5q: 'Why can’t we connect, or why are photos slow?',
  faq5a: 'A direct connection between the two devices is fastest. On a VPN, a campus network or mobile data, the devices often connect through a relay instead. Through a relay, a small preview shows first and the sharp photo replaces it a moment later. Turning off your VPN for a while usually helps.',
  faq6q: 'Do my friends get photos I haven’t flipped to yet?',
  sourceCode: 'Source code on GitHub',
  faq6a: 'They get the next two or three early, but they can’t open them. So that flipping feels instant, the next few photos are sent ahead, encrypted. Your friends can open a photo only once you flip to it. Photos you never flip to are cleared when the share ends.',

  connecting: 'Connecting…',
  watching: (n) => `${n} watching`,
  joined: (n) => `Someone joined. ${n} watching now`,
  connectHint: 'Not connected yet. Still trying. If you’re on a VPN, try turning it off for now, or switch to another network.',
  relayed: 'relayed',
  networkLater: 'Network trouble. Please try again later',
  lastPhoto: 'That’s the last photo',
  firstPhoto: 'That’s the first photo',
  shareEnded: 'Share ended',

  lastShareEnded: 'Your last share has ended',
  resuming: 'Restoring your share…',
  resumed: 'Back to your share. The link still works',
  resumedMissing: (n) => `Back to your share. The link still works. ${plural(n, 'photo wasn’t', 'photos weren’t')} saved in time. Tap + to add ${n === 1 ? 'it' : 'them'} again`,
  pickToContinue: 'Tap + below to choose photos and keep sharing. The link stays the same.',
  handedOff: 'Continued in another page',
  handedOffText: 'This share now continues in another page. You can close this one.',
  endedSelf: 'The photos are gone from your friends’ screens, and the link no longer works.',
  endedExpired: 'You were away from the share for over an hour, or it ran for 6 hours, so it ended on its own.',
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
  friendAway: 'Friend stepped away',
  friendJoinedTouch: 'Friend connected · Swipe to flip',
  friendJoinedMouse: 'Friend connected. Use the arrow keys or click the sides to flip',
  preparingCount: (n) => `Preparing ${plural(n, 'photo', 'photos')}`,
  preparingPhotos: 'Preparing photos…',
  hintPublic: 'Turn off any VPN for the smoothest sharing.',
  hintWeChat: 'Sharing from WeChat: after you send the link, tap the link you opened this page from again to keep flipping. The link keeps working.',
  hintTailscale: 'This is a Tailscale address. Only devices signed in to your Tailscale can open it.',
  hintLan: 'Your friend needs to be on the same Wi‑Fi. If it won’t open, try another address, or start public mode with npm run tunnel.',
  processing: (done, total) => `Processing photos ${done} / ${total}. Please stay on this page until it’s done`,
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
  linkGoneText: 'The sharer has ended this share, or the link is incomplete. Ask them to send a new link.',
  clearedHere: 'The photos have been cleared from this device.',
  backHome: 'Go to the home page',
  hostAway: 'Sharer away',
  hostAwayText: 'The sharer has left the page for now. Sharing picks up here when they’re back.',
  receiving: (p) => `Receiving ${p}`,
  live: 'Live',
  unstable: 'Unstable, reconnecting…',
  retrying: 'Disconnected, retrying…',
  backToLive: (n) => `Back to live · Photo ${n}`,
  receivingPhoto: (p) => `Receiving photo ${p}`,
  waitingFirst: 'Connected. Waiting for the first photo…',
  connectingPeer: 'Connecting to the sharer…',
};

function match(tag) {
  if (/^zh\b/i.test(tag)) return 'zh';
  if (/^en\b/i.test(tag)) return 'en';
  return null;
}

function browserLang() {
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    if (match(tag)) return match(tag);
  }
  return 'en';
}

const forced = match(new URLSearchParams(location.search).get('lang') ?? '');
export const lang = forced ?? browserLang();
// 页面内的链接带上它，指定过的语言不会在跳转后变回浏览器语言。发给朋友的加入链接不带，朋友按自己的浏览器
export const langQuery = forced ? `?lang=${forced}` : '';
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
