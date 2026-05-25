# backbase-boat-render

WebSocket proxy between the [backbase-boat](https://github.com/michakroes/backbase-boat) PWA and `wss://stream.aisstream.io`.

## Why this thing exists

1. **API key protection**: previously the aisstream API key sat in `live-ais.js`, so it was visible in the deployed bundle. It now lives in an env var on this server. The browser sends subscribe messages *without* the key; this proxy injects the key on its behalf.

2. **Cert bypass**: aisstream's Let's Encrypt cert expired on 2026-05-20 (see https://github.com/aisstream/issues/issues/192). Browsers cannot disable TLS validation, Node can via `rejectUnauthorized: false`. We only do that for the upstream connection to aisstream; the downstream (browser to proxy) uses Render's own valid cert.

## Architecture

```
Browser  --wss-- this proxy on Render --wss-- stream.aisstream.io
         (Render cert,                       (rejectUnauthorized: false
          valid Let's Encrypt)                until aisstream cert renews)
```

## Deploy on Render

1. Render dashboard -> **New** -> **Web Service**
2. Connect repo: `michakroes/backbase-boat-render`
3. Settings (defaults, leave alone):
   - **Root Directory**: empty (everything lives at the repo root)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. **Environment Variables**:
   - `AISSTREAM_API_KEY` = your aisstream API key
   - `REJECT_UPSTREAM_CERT` = `0` ONLY if you need to temporarily bypass strict TLS again (default is ON since 2026-05-25)
5. Create Web Service. Render builds + deploys automatically (~2-3 min).

## Local dev

```bash
git clone git@github.com:michakroes/backbase-boat-render.git
cd backbase-boat-render
npm install
AISSTREAM_API_KEY=your_key npm start
```

Server runs on `http://localhost:8080`. WebSocket endpoint: `ws://localhost:8080/ais`. Health check: `GET /health`.

## How the PWA uses it

In `config.local.js` (from the backbase-boat repo):

```js
window.AIS_PROXY_URL = 'wss://<your-render-name>.onrender.com/ais';
```

In `live-ais.js`:

```js
const URL = window.AIS_PROXY_URL || 'ws://localhost:8080/ais';
const ws = new WebSocket(URL);
ws.onopen = () => {
  ws.send(JSON.stringify({
    BoundingBoxes: [[52.34, 4.82], [52.42, 4.97]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', ...]
    // NB: NO APIKey field - the proxy injects it server-side.
  }));
};
```

## Cert future

Strict TLS verification is now ON by default (since 2026-05-25, after
aisstream renewed their cert). If aisstream's cert ever lapses again, set
`REJECT_UPSTREAM_CERT=0` in the Render dashboard as a temporary bypass and
flip it back to unset (or to `1`) once they renew. The status.html page
('AIS upstream cert' card) shows the cert state - 'cert OK' means strict is
active, 'cert expired' means the bypass should be enabled.
