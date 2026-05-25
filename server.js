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
const tls = require('node:tls');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.AISSTREAM_API_KEY;
const UPSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const UPSTREAM_HOST = 'stream.aisstream.io';
const UPSTREAM_PORT = 443;
// Strict TLS verification on the upstream connection to aisstream. Default
// is now ON (cert chain validated) since aisstream renewed their Let's
// Encrypt cert in 2026-05. Set REJECT_UPSTREAM_CERT=0 explicitly to disable
// (temporary bypass for the next time their cert lapses without warning).
const REJECT_UPSTREAM_CERT = process.env.REJECT_UPSTREAM_CERT !== '0';
// Probe interval - every 15 min we check whether aisstream has renewed their
// cert. Fast enough to notice within a deploy-cycle of theirs, slow enough
// to be polite (~96 connections/day, nothing).
const CERT_PROBE_INTERVAL_MS = 15 * 60 * 1000;
const CERT_PROBE_TIMEOUT_MS = 10 * 1000;

if (!API_KEY) {
  console.error('FATAL: AISSTREAM_API_KEY environment variable not set');
  process.exit(1);
}

// ── Upstream cert probe ─────────────────────────────────────────────────────
//
// Periodically opens a plain TLS socket (not WebSocket) to aisstream.io with
// rejectUnauthorized:false so we ALWAYS get the peer cert, even if it's
// expired. We then read socket.authorized (boolean) + socket.authorizationError
// (specific reason) to determine whether strict TLS would have worked.
//
// The result is cached in _certProbe and exposed via /health so status.html
// can show "cert expired (1d ago)" while the bypass is active, and flip to
// "cert valid until Aug 15 2026" the moment aisstream renews.
//
// Why not just probe on every /health request? Because health is hit ~1/s by
// status.html in auto-refresh mode and we don't want to spam aisstream with
// TLS handshakes. 15 min cadence is responsive enough for a manual operator
// to notice the renewal within a workday.
let _certProbe = {
  ok: false,
  error: 'not yet probed',
  notAfter: null,
  notBefore: null,
  issuer: null,
  daysUntilExpiry: null,
  lastChecked: null,
  probeDurationMs: null,
};

function probeUpstreamCert() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      result.lastChecked = new Date(startedAt).toISOString();
      result.probeDurationMs = Date.now() - startedAt;
      resolve(result);
    };

    const socket = tls.connect({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      servername: UPSTREAM_HOST,
      rejectUnauthorized: false,    // allow connection so we can READ the bad cert
      timeout: CERT_PROBE_TIMEOUT_MS,
    }, () => {
      const cert = socket.getPeerCertificate() || {};
      // valid_to/valid_from are formatted like "May 20 10:59:33 2026 GMT".
      // Convert to ISO + days-until-expiry so the client doesn't have to
      // parse the unusual format.
      const notAfterMs = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      const notBeforeMs = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
      const daysUntilExpiry = !isNaN(notAfterMs)
        ? Math.round((notAfterMs - Date.now()) / 86400000)
        : null;
      // Issuer fields differ per CA - prefer CN (e.g. "R12"), fall back to O.
      const issuer = cert.issuer
        ? (cert.issuer.CN || cert.issuer.O || null)
        : null;
      try { socket.end(); } catch (e) {}
      settle({
        ok: !!socket.authorized,
        error: socket.authorizationError ? String(socket.authorizationError) : null,
        notAfter: !isNaN(notAfterMs) ? new Date(notAfterMs).toISOString() : null,
        notBefore: !isNaN(notBeforeMs) ? new Date(notBeforeMs).toISOString() : null,
        issuer,
        daysUntilExpiry,
      });
    });

    socket.on('error', (err) => {
      settle({
        ok: false,
        error: err.message || String(err),
        notAfter: null,
        notBefore: null,
        issuer: null,
        daysUntilExpiry: null,
      });
    });
    socket.on('timeout', () => {
      try { socket.destroy(); } catch (e) {}
      settle({
        ok: false,
        error: 'timeout after ' + CERT_PROBE_TIMEOUT_MS + 'ms',
        notAfter: null,
        notBefore: null,
        issuer: null,
        daysUntilExpiry: null,
      });
    });
  });
}

function refreshCertProbe() {
  return probeUpstreamCert().then((result) => {
    _certProbe = result;
    const verdict = result.ok ? 'OK'
      : (result.error ? 'BAD: ' + result.error : 'UNKNOWN');
    const expiry = result.notAfter
      ? ' (expires ' + result.notAfter + ', ' + result.daysUntilExpiry + 'd)'
      : '';
    console.log('[cert-probe] ' + verdict + expiry);
    return result;
  });
}

// Boot probe + recurring probe.
refreshCertProbe();
setInterval(refreshCertProbe, CERT_PROBE_INTERVAL_MS).unref();

// ── HTTP server: health check + WebSocket upgrade endpoint ─────────────────
//
// CORS: /health is hit cross-origin by status.html on backbase-boat.netlify.app
// (and share.backbase.com). Without Access-Control-Allow-Origin the browser
// blocks the response body and status.html shows the proxy as "down" even
// though it returned 200. We allow any origin because /health exposes no
// sensitive data (just uptime + config flags) and the WS endpoint has its
// own auth model (API key injected server-side). OPTIONS preflight is
// answered too in case a caller sends custom headers.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '600',
  'cache-control': 'no-store',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS));
    // locWss is defined below but available at request time since /health
    // is never hit before the server has fully booted.
    const locClients = (typeof locWss !== 'undefined' && locWss) ? locWss.clients.size : 0;
    res.end(JSON.stringify({
      ok: true,
      service: 'backbase-boat-ais-proxy',
      upstream: UPSTREAM_URL,
      strictTls: REJECT_UPSTREAM_CERT,
      uptimeSec: Math.round(process.uptime()),
      upstreamCert: _certProbe,
      locationBroadcast: {
        clients: locClients,
        lastCaptainFixTs: _lastCaptainFixServerTs,
        hasFix: !!_lastCaptainFix,
      },
    }));
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end('not found');
});

// ── WebSocket server: per-browser-client pipeline ───────────────────────────
// Each browser client opening /ais gets its own dedicated upstream connection.
// Trade-off: more upstream sockets vs. simpler code. For our scale (handful
// of users on a boat trip) this is the right call - one shared upstream
// would need more reconnect logic and broadcast plumbing.
//
// Multi-path upgrade routing: with two WS servers on one HTTP server, you
// CANNOT pass {server, path} to both - the second WebSocket.Server overrides
// the upgrade handler of the first. Use noServer:true + manual route.
const wss = new WebSocket.Server({ noServer: true });

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

// ── Location broadcast: captain -> passengers ──────────────────────────────
//
// Lets the captain phone (the one logged into live.html or live-mapbox.html
// in captain mode) broadcast its GPS position to all passengers (the phones
// that scanned the QR code and opened the passenger view). Without this,
// every phone read its own GPS - which works because they were all on the
// same boat, but breaks the moment one passenger phone's GPS is flaky.
//
// Wire protocol (JSON over WebSocket at /location):
//   Client -> Server:
//     { type: 'captain-update', position: { lat, lng, heading?, sog?, accuracy?, ts? } }
//       Sent by the captain on every onGpsFix. ts is ms since epoch.
//   Server -> Client (broadcast to all connected):
//     { type: 'captain-fix', position: {...}, serverTs: ms }
//       Sent on every captain-update + immediately on a new client connect
//       (replays the last known position so a late passenger sees the boat
//       right away).
//
// Authentication: none for v1. The boat trip is closed group (8 phones on
// 1 boat) and the WS path is unguessable enough. Future hardening: a trip
// token in the query string + check at upgrade.
//
// State: kept in memory only. If the server restarts, the next captain
// update repopulates within ~1s.
const locWss = new WebSocket.Server({ noServer: true });

// Single upgrade handler that routes /ais to wss and /location to locWss.
// Anything else gets a clean socket destroy (no protocol confusion).
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  if (pathname === '/ais') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/location') {
    locWss.handleUpgrade(req, socket, head, (ws) => locWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

let _lastCaptainFix = null;          // { lat, lng, heading, sog, accuracy, ts }
let _lastCaptainFixServerTs = null;  // server-side receive timestamp (ms)

function broadcastCaptainFix(payload) {
  const message = JSON.stringify({
    type: 'captain-fix',
    position: payload,
    serverTs: _lastCaptainFixServerTs,
  });
  for (const client of locWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (e) { /* ignore */ }
    }
  }
}

locWss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const clientId = Math.random().toString(36).slice(2, 8);
  console.log(`[loc:${clientId}] client connected from ${clientIp} (total=${locWss.clients.size})`);

  // Replay the last known position immediately so a passenger joining mid-trip
  // sees the boat without waiting for the next captain GPS fix.
  if (_lastCaptainFix) {
    try {
      ws.send(JSON.stringify({
        type: 'captain-fix',
        position: _lastCaptainFix,
        serverTs: _lastCaptainFixServerTs,
      }));
    } catch (e) { /* ignore */ }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg && msg.type === 'captain-update' && msg.position
        && typeof msg.position.lat === 'number'
        && typeof msg.position.lng === 'number') {
      // Sanity-check the coordinates: Amsterdam-area bbox roughly + some
      // slack for accidental NaN. Out-of-range payloads silently drop.
      const { lat, lng } = msg.position;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      _lastCaptainFix = {
        lat, lng,
        heading: typeof msg.position.heading === 'number' ? msg.position.heading : null,
        sog: typeof msg.position.sog === 'number' ? msg.position.sog : null,
        accuracy: typeof msg.position.accuracy === 'number' ? msg.position.accuracy : null,
        ts: typeof msg.position.ts === 'number' ? msg.position.ts : Date.now(),
      };
      _lastCaptainFixServerTs = Date.now();
      broadcastCaptainFix(_lastCaptainFix);
    }
  });

  ws.on('close', () => {
    console.log(`[loc:${clientId}] disconnected (total=${locWss.clients.size - 1})`);
  });
  ws.on('error', (err) => {
    console.warn(`[loc:${clientId}] error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`[ais-proxy] listening on :${PORT}`);
  console.log(`[ais-proxy] upstream: ${UPSTREAM_URL}`);
  console.log(`[ais-proxy] strict TLS: ${REJECT_UPSTREAM_CERT}`);
  console.log('[ais-proxy] paths: /ais (AIS relay), /location (captain broadcast)');
});
