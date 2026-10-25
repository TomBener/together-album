# 一起翻相册

面对面分享照片的临时 Web App：分享者选好照片，朋友扫码在自己的屏幕上同步观看，不用把手机递过去。不在一起时，把链接发过去，边通话边看也可以。照片通过 WebRTC 从分享者的浏览器**直接加密传到**朋友的浏览器，不上传服务器。

## 技术方案

```
分享者浏览器 ══ WebRTC 数据通道（DTLS 加密，点对点）══▶ 观看者浏览器
      │                                                    │
      └──── WebSocket + HTTP：只交换连接信令（SDP/ICE）──────┘
                              │
            信令服务器（线上：Cloudflare Workers；本地：Node.js）
```

- **信令服务器**：只保存会话 ID、分享者密钥和在线名单，负责生成加入二维码、转发建立直连所需的信令，不经手照片。有两个实现，接口完全相同：
  - 线上 `worker/index.js`：Cloudflare Workers + Durable Objects，每个会话一个 Durable Object，WebSocket 用休眠 API；
  - 本地 `server/app.js`：Node.js 原生 `http` + `ws` + `qrcode`，全在内存里，可以在没有外网的局域网里用。
- **前端**：原生 JS 模块，无构建步骤。手机优先的响应式布局，两端共用一个页面。界面按浏览器的语言偏好显示中文或英文（其他语言显示英文），也可以在网址后加 `?lang=en` 或 `?lang=zh` 指定；文字都在 `public/js/i18n.js` 里。
- **照片处理**：在分享者浏览器里缩到长边 2048 px 并重新编码为 JPEG。重新编码会去掉 EXIF（包括 GPS 位置），方向按 EXIF 摆正。
- **只发翻到的那张**：分享者翻到哪张，才把那一张发给观看者；快速连翻时跳过中途没停留的照片。观看者可以左右滑动，回看对方翻到过的照片，但翻不到对方还没翻到的。自己翻到别处时不会被分享者拉走，点“回到同步”回到对方正在看的那张。
- **结束即清除**：点“结束”、关闭或刷新分享页都会结束会话，观看端立刻释放所有照片并显示“已结束”。会话也会在分享者离线 1 小时或开始 6 小时后自动结束。

各方能看到什么：

| 谁 | 能看到 |
| --- | --- |
| 信令服务器（Cloudflare Workers 或本地 Node）、Cloudflare 隧道 | 连接信令（含双方 IP 地址），看不到照片 |
| STUN 服务器（默认 Cloudflare、Google） | 你的公网 IP，看不到照片 |
| 照片内容 | 只有分享者和观看者的浏览器 |

## 部署（Cloudflare Workers）

用 Cloudflare 的 `cf` CLI 部署，配置在 `cloudflare.config.ts`（Worker、Durable Object、自定义域名），静态资源目录在 `wrangler.config.ts`（`public/`）。Durable Object 使用 SQLite 存储，免费计划即可。

自定义域名写在项目根目录的 `.env` 里（已被 `.gitignore` 忽略，不会提交），域名要托管在同一个 Cloudflare 账号下；不写时只部署到 `workers.dev` 地址：

```bash
echo 'ALBUM_DOMAIN=album.example.com' > .env
```

```bash
npm install
cf auth login        # 第一次部署前登录
npm run deploy       # 即 cf deploy：构建、上传并绑定 .env 里的域名
npm run dev:worker   # 即 cf dev：在本机运行 Worker 版本（http://localhost:8787）
```

## 本地运行（Node 版）

不想依赖外网时，用 Node 版信令服务器。需要 Node.js 20 以上。

```bash
npm install
npm start        # 局域网模式
npm run tunnel   # 附带一个临时公网 HTTPS 地址（需要 cloudflared）
```

启动后终端会打印访问地址，并给出一个二维码，分享者用手机扫这个码打开页面。macOS 第一次运行时如果弹出“是否允许 node 接受传入连接”，选允许。

隧道模式用 Cloudflare 的免费临时隧道（`brew install cloudflared`，不用注册），每次启动地址都会变。隧道只转发网页和信令，照片不经过它；它还提供 HTTPS，这样手机上才能保持屏幕常亮。

## 用两台真实设备测试

1. 用你的手机打开部署好的线上地址（或本地模式下扫终端里的二维码），这是分享者页面。
2. 点“选择照片，开始分享”，选几张照片。页面立即弹出加入二维码，照片在后台压缩。
3. 朋友用手机相机扫这个二维码，浏览器里直接打开。也可以点二维码下方的“用隔空投送发给朋友”（安卓上是“发送链接”），通过系统分享面板把链接发过去；这个按钮只在 HTTPS 下出现。连上后两边左上角都显示“1 人在看”，朋友那边显示第一张照片。之后再有人加入，所有人的人数都会跟着变。
4. 在你的手机上左右滑动（电脑上用方向键）翻页，朋友的屏幕跟着翻。
5. 朋友在自己手机上往回滑，可以回看你翻过的照片；这时你继续翻页，朋友那边只更新“回到同步 · 第 N 张”按钮，点一下就跟上。
6. 点“结束”，朋友的屏幕立刻清空，显示“分享已结束”。

连不上时：

- **页面打不开**（本地模式）：局域网模式要求两台设备连同一个 Wi‑Fi，而校园网、公司网经常禁止设备互相访问，这时改用线上地址或 `npm run tunnel`。
- **页面打开了，但一直“正在连接对方”**：说明两台设备之间直连不通。最常见的原因是开着 VPN（Surge、Clash、Shadowrocket 等接管全部流量的代理），其次是设备隔离的 Wi‑Fi 或部分蜂窝网络。暂时关掉 VPN；在一起的话，也可以让一台手机开个人热点、另一台连上，页面会自动重试。连了 8 秒还没连上时，两端都会显示这条提示。
- **为什么不加 TURN 中继**：试过 Cloudflare 的 TURN 中继，开着 VPN 也能连上，但照片要绕到海外再回来，实测每张要等 4–7 秒，面对面用很难接受，还要管理密钥和流量费用。所以只做直连，连不上时提示用户换网络。需要时可以从 git 历史里的“Relay through Cloudflare TURN when a direct connection fails”这次提交恢复。
- 二维码下方可以切换地址（公网、Wi‑Fi、以太网、Tailscale）。

## 自动测试

```bash
npm test                                          # 测本地 Node 版
TEST_BASE_URL=http://localhost:8787 npm test      # 测 cf dev 中的 Worker 版
TEST_BASE_URL=https://album.example.com npm test  # 测线上
```

两个版本跑同一套测试，覆盖信令服务器：创建会话、加入、双向转发信令、离开、结束后所有人收到通知并且链接失效；权限（没有密钥不能冒充分享者、观看者不能给别的观看者发信令、拒绝其他网站的连接）；同一观看者断线重连不重复计数；路径穿越。

WebRTC 部分需要浏览器，可以在一台电脑上开两个窗口测试：一个打开首页当分享者，另一个用无痕窗口打开加入链接当观看者。

## 配置

Node 版通过环境变量配置；Worker 版的 `ICE_SERVERS` 可以在 `cloudflare.config.ts` 的 `env` 里用 `bindings.text(...)` 设置。

| 环境变量 | 作用 |
| --- | --- |
| `PORT` | 端口，默认 3000 |
| `HOST` | 监听地址，默认所有网卡 |
| `PUBLIC_URL` | 部署到自己的 HTTPS 域名时填写，二维码会优先用它 |
| `ICE_SERVERS` | WebRTC 的 STUN/TURN 配置（JSON 数组）。设成 `[]` 只走局域网直连，不联系任何第三方；如需穿透更严格的网络，可以加 TURN 服务器，TURN 只转发加密后的数据，看不到照片 |

## 已知限制

- 分享时分享者页面要留在前台。iOS 锁屏或切到别的 App 会断开直连，回来后自动重连。
- 照片只在分享者页面的内存里，刷新分享页就等于结束分享。
- 没有 TURN 中继，开着 VPN 或在部分网络组合下无法直连（见上面的办法）。
- 观看端禁用了长按存图，但防不了截图和拍屏。
- 局域网 http 下浏览器不提供屏幕常亮和剪贴板接口，用隧道模式（HTTPS）可以解决。

## 目录结构

```
cloudflare.config.ts 线上部署配置（cf CLI）：Worker、Durable Object、自定义域名
wrangler.config.ts   线上构建配置：静态资源目录
worker/index.js      线上信令服务器（Workers + Durable Objects）
server.js            本地启动入口：打印地址和二维码，可选开启隧道
server/app.js        本地信令服务器：HTTP 路由、会话、WebSocket 推送、信令转发
server/network.js    局域网地址识别、cloudflared 隧道
public/index.html    页面骨架（分享者和观看者共用）
public/style.css     样式
public/js/host.js    分享者：选图、翻页、管理每位观看者的直连
public/js/viewer.js  观看者：接收照片、同步显示、结束时清除
public/js/rtc.js     WebRTC 连接与分片传输协议
public/js/images.js  浏览器内压缩、去除 EXIF
public/js/live.js    实时通道（WebSocket 自动重连）
public/js/stage.js   照片切换动画、背景光、拖动翻页手势
public/js/i18n.js    界面文字（中文、英文）和语言选择
test/                信令服务器测试（Node 版和 Worker 版共用）
```
