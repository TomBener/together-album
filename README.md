# 一起翻相册

面对面分享照片的网页：分享者选好照片，朋友扫码，在自己的屏幕上跟着翻看，不用把手机递过去。不在一起时，发个链接也行。

照片从分享者的浏览器加密直传到朋友的浏览器，不上传服务器。两台设备连不通时，经 Cloudflare 中转，中转只转发加密后的数据。

## 工作原理

```
分享者浏览器 ══ WebRTC（加密，点对点；连不通时经 TURN 中转）══▶ 朋友的浏览器
      └────────── 信令服务器：只帮两边建立连接，不经手照片 ──────────┘
```

- 照片在分享者的浏览器里缩到长边 2048 px，去掉位置信息，另做一张 640 px 的预览。翻页时先发预览，原画质随后换上。
- 后面几张会提前发过去，但每张都用自己的钥匙锁着。分享者翻到哪张，才把那张的钥匙发给朋友。
- 点“结束”，朋友屏幕上的照片立即清除，链接失效。分享者关掉页面后，1 小时内回来可以接着分享。
- 信令服务器有两个版本：线上用 Cloudflare Workers（`worker/index.js`），本地用 Node.js（`server/app.js`）。

## 谁能看到什么

| 谁 | 能看到 |
| --- | --- |
| 信令服务器 | 双方的 IP 地址，看不到照片 |
| STUN 服务器（Cloudflare、小米） | 你的公网 IP |
| TURN 中转（Cloudflare，直连不通时才用） | 双方的 IP 和数据量，看不到照片 |
| 照片 | 只在分享者和朋友的浏览器里 |

## 本地运行

需要 Node.js 20 以上。

```bash
npm install
npm start        # 局域网模式，终端里会打印地址和二维码
npm run tunnel   # 另加一个临时的公网 HTTPS 地址（需要 cloudflared）
```

可以用环境变量 `PORT`、`HOST`、`PUBLIC_URL`、`ICE_SERVERS` 配置。

## 部署到 Cloudflare

```bash
echo 'ALBUM_DOMAIN=album.example.com' > .env   # 自定义域名；不写就只用 workers.dev 地址
cf auth login
npm run deploy
```

中转用 Cloudflare 的 TURN 服务。新建一个密钥，存进钥匙串，再设成 Worker 的 secret。只需设一次：

```bash
cf realtime turn keys create --name together-album    # 记下输出里的 uid 和 secret
security add-generic-password -a together-album -s together-album.TURN_KEY_ID -w '<uid>'
security add-generic-password -a together-album -s together-album.TURN_KEY_API_TOKEN -w '<secret>'
for name in TURN_KEY_ID TURN_KEY_API_TOKEN; do
  cf workers secrets update "$name" --worker together-album --type secret_text \
    --text "$(security find-generic-password -a together-album -s together-album.$name -w)"
done
```

不要用 `cf deploy --secrets-file` 传这两项：它会把变量名原样当成密钥上传。

## 测试

```bash
npm test                                          # 本地 Node 版
TEST_BASE_URL=https://album.example.com npm test  # 线上
```

排查连接时，在网址后加 `?debug=1`，状态栏会标出是否经中转；加 `?relay=1`，这一页只走中转。

## 开源

AGPL-3.0，见 `LICENSE`。线上网页运行的脚本和样式，就是 `public/` 下的这些文件。照片的压缩在 `public/js/images.js`，加密在 `public/js/seal.js`，传输在 `public/js/rtc.js`。
