// ais-proxy / server.js
//
// WebSocket proxy between browser PWAs (backbase-boat) and stream.aisstream.io.
// Two reasons this server exists:
//
//   1. SECURITY: keep AISSTREAM_API_KEY server-side. The previous setup baked
//      it into live-ais.js which meant anyone reading the deployed bundle on
//      Netlify could lift the key. With this proxy the browser never sees it.
//
//   2. CERT BYPASS: aisstream.io's Let's Encrypt certificate expired on
//      2026-05-20 and at the time of writing has not been renewed. Browsers
//      cannot disable cert verification so the PWA's direct connection 1006'd
//      out. Node CAN disable verification per-connection via the `ws` library
//      option `rejectUnauthorized: false`. We apply that ONLY to the upstream
//      connection from this server to aisstream.io. The downstream connection
//      between browser and this server uses Render's own valid Let's Encrypt
//      cert so the user sees a green padlock.
//
// Architecture:
//   Browser  ──wss── this server (Render, valid cert)
//                   │
//                   └──wss── stream.aisstream.io (rejectUnauthorized:false)
//
// Once aisstream renews their cert we'll set REJECT_UPSTREAM_CERT=1 to flip
// back to strict TLS without redeploying.
//
// Subscription protocol (matches aisstream's native protocol so the browser
// code in live-ais.js needs zero changes beyond the URL):
//   - Browser opens WebSocket to /ais
//   - Browser sends subscription JSON like:
//       { BoundingBoxes: [...], FilterMessageTypes: [...] }
//     Note: NO APIKey field - we inject it server-side.
//   - Server forwards the subscription to aisstream WITH the api key added.
//   - All upstream messages get relayed verbatim to the browser.

const http = require('node:http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.AISSTREAM_API_KEY;
const UPSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
// REJECT_UPSTREAM_CERT=1 toggles strict TLS back on (set this once aisstream
// renews their cert). Default false = bypass active.
const REJECT_UPSTREAM_CERT = process.env.REJECT_UPSTREAM_CERT === '1';

if (!API_KEY) {
  console.error('FATAL: AISSTREAM_API_KEY environment variable not set');
  process.exit(1);
}

// ── HTTP server: health check + WebSocket upgrade endpoint ─────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'backbase-boat-ais-proxy',
      upstream: UPSTREAM_URL,
      strictTls: REJECT_UPSTREAM_CERT,
      uptimeSec: Math.round(process.uptime()),
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ── WebSocket server: per-browser-client pipeline ───────────────────────────
// Each browser client opening /ais gets its own dedicated upstream connection.
// Trade-off: more upstream sockets vs. simpler code. For our scale (handful
// of users on a boat trip) this is the right call - one shared upstream
// would need more reconnect logic and broadcast plumbing.
const wss = new WebSocket.Server({ server, path: '/ais' });

wss.on('connection', (browser, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const clientId = Math.random().toString(36).slice(2, 8);
  console.log(`[${clientId}] browser connected from ${clientIp}`);

  // Open the dedicated upstream WebSocket. rejectUnauthorized:false is the
  // cert bypass. Once aisstream renews we flip via env var.
  const upstream = new WebSocket(UPSTREAM_URL, {
    rejectUnauthorized: REJECT_UPSTREAM_CERT,
  });

  // Buffer any messages from the browser that arrive before upstream has
  // opened. Most browsers send the subscription instantly after .open() so
  // we'd otherwise race the upstream handshake and drop the subscribe.
  let upstreamOpen = false;
  const pending = [];

  upstream.on('open', () => {
    upstreamOpen = true;
    console.log(`[${clientId}] upstream open`);
    // Replay any browser messages that arrived during the handshake.
    while (pending.length) {
      const msg = pending.shift();
      try { upstream.send(msg); } catch (e) { /* ignore */ }
    }
  });

  // Browser -> upstream: inject the API key into the subscription message
  // so the browser never has to know it.
  browser.on('message', (raw) => {
    let injected;
    try {
      const sub = JSON.parse(raw.toString());
      sub.APIKey = API_KEY;
      injected = JSON.stringify(sub);
    } catch (e) {
      // Not JSON - just pass through (defensive; aisstream protocol is JSON).
      injected = raw;
    }
    if (upstreamOpen) {
      try { upstream.send(injected); } catch (e) { /* ignore */ }
    } else {
      pending.push(injected);
    }
  });

  // Upstream -> browser: just relay. Frames are binary on aisstream's side.
  upstream.on('message', (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) {
      try { browser.send(data, { binary: isBinary }); } catch (e) { /* ignore */ }
    }
  });

  upstream.on('close', (code, reason) => {
    console.log(`[${clientId}] upstream closed code=${code} reason=${reason || '?'}`);
    if (browser.readyState === WebSocket.OPEN) browser.close(code, reason);
  });
  upstream.on('error', (err) => {
    console.warn(`[${clientId}] upstream error: ${err.message}`);
    if (browser.readyState === WebSocket.OPEN) browser.close(1011, 'upstream error');
  });

  browser.on('close', (code, reason) => {
    console.log(`[${clientId}] browser closed code=${code}`);
    try { upstream.close(code, reason); } catch (e) { /* ignore */ }
  });
  browser.on('error', (err) => {
    console.warn(`[${clientId}] browser error: ${err.message}`);
    try { upstream.close(1011, 'browser error'); } catch (e) { /* ignore */ }
  });
});

server.listen(PORT, () => {
  console.log(`[ais-proxy] listening on :${PORT}`);
  console.log(`[ais-proxy] upstream: ${UPSTREAM_URL}`);
  console.log(`[ais-proxy] strict TLS: ${REJECT_UPSTREAM_CERT}`);
});
