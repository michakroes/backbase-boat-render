# backbase-boat-render

WebSocket-proxy tussen de [backbase-boat](https://github.com/michakroes/backbase-boat) PWA en `wss://stream.aisstream.io`.

## Waarom dit ding bestaat

1. **API key beveiliging**: voorheen stond de aisstream API key in `live-ais.js`, dus zichtbaar in de deployed bundle. Nu staat 'ie in een env var op deze server. De browser stuurt subscribe-messages *zonder* key; deze proxy injecteert de key voor 'm.

2. **Cert bypass**: aisstream's Let's Encrypt cert is verlopen op 2026-05-20 (zie https://github.com/aisstream/issues/issues/192). Browsers kunnen TLS-validatie niet uitschakelen, Node wel via `rejectUnauthorized: false`. We doen dat alleen voor de upstream-connectie naar aisstream; de downstream (browser ↔ proxy) gebruikt Render's eigen geldige cert.

## Architectuur

```
Browser  ──wss── this proxy on Render ──wss── stream.aisstream.io
         (Render cert,                     (rejectUnauthorized: false
          valid Let's Encrypt)              tot aisstream cert renewt)
```

## Deploy op Render

1. Render dashboard → **New** → **Web Service**
2. Connect repo: `michakroes/backbase-boat-render`
3. Settings (default, niks aanpassen):
   - **Root Directory**: leeg (alles staat in root)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. **Environment Variables**:
   - `AISSTREAM_API_KEY` = jouw aisstream API key
   - `REJECT_UPSTREAM_CERT` = `1` (zet pas zodra aisstream cert vernieuwd is — niet nu)
5. Create Web Service. Render bouwt + deployt automatisch (~2-3 min).

## Local dev

```bash
git clone git@github.com:michakroes/backbase-boat-render.git
cd backbase-boat-render
npm install
AISSTREAM_API_KEY=jouw_key npm start
```

Server start op `http://localhost:8080`. WebSocket endpoint: `ws://localhost:8080/ais`. Health check: `GET /health`.

## Hoe de PWA hem gebruikt

In `config.local.js` (van het backbase-boat repo):

```js
window.AIS_PROXY_URL = 'wss://<jouw-render-naam>.onrender.com/ais';
```

In `live-ais.js`:

```js
const URL = window.AIS_PROXY_URL || 'ws://localhost:8080/ais';
const ws = new WebSocket(URL);
ws.onopen = () => {
  ws.send(JSON.stringify({
    BoundingBoxes: [[52.34, 4.82], [52.42, 4.97]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', ...]
    // NB: GEEN APIKey field — proxy injecteert 'm server-side.
  }));
};
```

## Cert toekomst

Zodra aisstream hun cert vernieuwt → in Render dashboard env var `REJECT_UPSTREAM_CERT=1` zetten → herstart → terug naar strikte TLS verificatie. Geen code-wijziging nodig.
