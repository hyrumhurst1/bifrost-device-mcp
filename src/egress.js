// Loopback forward proxy that the isolated browser must use for every HTTP(S) request.
// Playwright request routing only sees the first hop of a redirect chain; Chromium sends every hop
// through this proxy, so each one is checked against the exact-origin allowlist before it leaves.
import http from 'node:http';
import net from 'node:net';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// CONNECT targets must be a bare host:port authority, with no path, query or credentials.
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/i;

function withoutHopByHop(headers) {
  const result = { ...headers };
  for (const name of HOP_BY_HOP) delete result[name];
  return result;
}

function refuse(res) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('Blocked by Bifrost: origin is not operator-approved');
}

function parseAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export async function startEgressProxy(isAllowed) {
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    const target = parseAbsoluteHttpUrl(req.url);
    if (!target || !isAllowed(target.href)) return refuse(res);
    const upstream = http.request(
      {
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers: withoutHopByHop(req.headers),
        timeout: 30000,
      },
      (response) => {
        res.writeHead(response.statusCode, withoutHopByHop(response.headers));
        response.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket) => {
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    socket.on('error', () => socket.destroy());
    let target = null;
    if (AUTHORITY.test(req.url)) {
      try {
        target = new URL(`https://${req.url}`);
      } catch {
        target = null;
      }
    }
    if (!target || !isAllowed(target.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(
      Number(target.port || 443),
      target.hostname.replace(/^\[|\]$/g, ''),
    );
    tunnels.add(upstream);
    upstream.on('close', () => tunnels.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    address: () => server.address(),
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
