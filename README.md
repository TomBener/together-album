# Together Album

A web page for sharing photos face to face. The host picks some photos, a friend scans a QR code, and both flip through the photos together, each on their own screen. Nobody has to pass a phone around. When you're not together, send the link instead.

Photos go encrypted from the host's browser straight to the friend's browser. They are never uploaded to a server. When the two devices can't connect directly, the data goes through a Cloudflare relay, which only passes along encrypted data.

## How it works

```
Host's browser ══ WebRTC (encrypted, peer to peer; via a TURN relay if needed) ══▶ Friend's browser
      └──────── Signaling server: only helps the two connect, never sees photos ────────┘
```

- The host's browser shrinks each photo to 2048 px on the long edge, removes its location data, and makes a 960 px preview. On each flip the preview goes first and the full photo replaces it. When the friend watches on a big screen (Mac, iPad) over a direct connection, the photo on screen is then replaced with a 3072 px version.
- The next few photos are sent ahead, each locked with its own key. The friend gets a photo's key only when the host flips to it.
- Tapping End clears the photos from the friend's screen at once, and the link stops working. If the host closes the page, they can come back within an hour and carry on.
- The signaling server comes in two versions: Cloudflare Workers in production (`worker/index.js`) and Node.js for local use (`server/app.js`).

## Who can see what

| Who | Can see |
| --- | --- |
| Signaling server | Both IP addresses, not the photos |
| STUN servers (Cloudflare, Xiaomi) | Your public IP address |
| TURN relay (Cloudflare, only when a direct connection fails) | Both IP addresses and how much data passes, not the photos |
| Photos | Only the host's and the friend's browsers |

## Run locally

Requires Node.js 20 or later.

```bash
npm install
npm start        # LAN mode; prints the address and a QR code in the terminal
npm run tunnel   # also opens a temporary public HTTPS address (needs cloudflared)
```

Configure with the environment variables `PORT`, `HOST`, `PUBLIC_URL` and `ICE_SERVERS`.

## Deploy to Cloudflare

```bash
echo 'ALBUM_DOMAIN=album.example.com' > .env   # custom domain; without it, only the workers.dev address is used
cf auth login
npm run deploy
```

The relay uses Cloudflare's TURN service. Create a key, store it in the Keychain, then set it as Worker secrets. This is needed only once:

```bash
cf realtime turn keys create --name together-album    # note the uid and secret in the output
security add-generic-password -a together-album -s together-album.TURN_KEY_ID -w '<uid>'
security add-generic-password -a together-album -s together-album.TURN_KEY_API_TOKEN -w '<secret>'
for name in TURN_KEY_ID TURN_KEY_API_TOKEN; do
  cf workers secrets update "$name" --worker together-album --type secret_text \
    --text "$(security find-generic-password -a together-album -s together-album.$name -w)"
done
```

Don't pass these two with `cf deploy --secrets-file`: it uploads the variable names themselves as the secret values.

## Test

```bash
npm test                                          # local Node.js version
TEST_BASE_URL=https://album.example.com npm test  # production
```

To debug a connection, add `?debug=1` to the address: the status bar then shows whether the relay is in use. With `?relay=1`, that page connects only through the relay.

## Open source

AGPL-3.0; see `LICENSE`. The scripts and styles the live site runs are exactly the files in `public/`. Photos are compressed in `public/js/images.js`, encrypted in `public/js/seal.js` and sent in `public/js/rtc.js`.
