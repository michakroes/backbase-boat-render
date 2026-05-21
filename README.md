# backbase-boat AIS proxy

WebSocket relay tussen de PWA in de browser en `wss://stream.aisstream.io`.

## Waarom dit ding bestaat

1. **API key beveiliging**: voorheen stond de aisstream API key in `live-ais.js`, dus zichtbaar in het Netlify bundle. Nu staat 'ie in een env var op deze server. De browser stuurt subscribe-messages *zonder* key; deze proxy injecteert de key voor 'm.

2. **Cert bypass**: aisstream's Let's Encrypt cert is verlopen op 2026-05-20 (zie https://github.com/aisstream/issues/issues/192). Browsers kunnen TLS-validatie niet uitschakelen, Node wel via `rejectUnauthorized: false`. We doen dat alleen voor de upstream-connectie naar aisstream; de downstream (browser ↔ proxy) gebruikt Render's eigen geldige cert.

## Architectuur

```
Browser  ──wss── this proxy on Render ──wss── stream.aisstream.io
         (Render cert,                     (rejectUnauthorized: false
          valid Let's Encrypt)              tot aisstream cert renewt)
```

## Deploy op Render

1. Render dashboard → New → Web Service
2. Connect repo: `backbase-data/backbase-boat`
3. Root Directory: `ais-proxy`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Instance Type: Free
7. Environment Variables:
   - `AISSTREAM_API_KEY` = (jouw aisstream key)
   - `REJECT_UPSTREAM_CERT` = `1` (alleen flippen zodra aisstream cert vernieuwd is)

## Local dev

```bash
cd ais-proxy
npm install
AISSTREAM_API_KEY=jouw_key npm run dev
```

Server start op `http://localhost:8080`. WebSocket endpoint: `ws://localhost:8080/ais`. Health check: `GET /health`.

## Hoe de PWA hem gebruikt

In `live-ais.js`:

```js
const URL = location.hostname === 'localhost'
  ? 'ws://localhost:8080/ais'
  : 'wss://<jouw-render-url>.onrender.com/ais';

const ws = new WebSocket(URL);
ws.onopen = () => {
  ws.send(JSON.stringify({
    BoundingBoxes: [[52.34, 4.82], [52.42, 4.97]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', ...]
    // NB: GEEN APIKey field - proxy injecteert.
  }));
};
```

## Cert toekomst

Zodra aisstream hun cert vernieuwt → set Render env var `REJECT_UPSTREAM_CERT=1` → herstart → terug naar strikte TLS verificatie. Geen code-wijziging nodig.
