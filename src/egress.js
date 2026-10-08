// Loopback forward proxy that the isolated browser must use for every HTTP(S) request.
// Playwright request routing only sees the first hop of a redirect chain; Chromium sends every hop
// through this proxy, so each one is checked against the exact-origin allowlist before it leaves.
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
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

function failUpstream(res) {
  if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
  res.end();
}

function parseAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export async function startEgressProxy(isAllowed, { lookup = dns.lookup } = {}) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  // Each hostname keeps its first DNS answer for the life of the browser, so an approved name
  // cannot be rebound to loopback or private addresses after the page has loaded.
  const pinned = new Map();
  const resolve = (hostname) => {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) return Promise.resolve(bare);
    if (!pinned.has(bare)) {
      const answer = Promise.resolve(lookup(bare)).then(({ address }) => address);
      answer.catch(() => pinned.delete(bare));
      pinned.set(bare, answer);
    }
    return pinned.get(bare);
  };

  const server = http.createServer(async (req, res) => {
    const target = parseAbsoluteHttpUrl(req.url);
    if (!target || !isAllowed(target.href)) return refuse(res);
    let address;
    try {
      address = await resolve(target.hostname);
    } catch {
      return failUpstream(res);
    }
    const upstream = http.request(
      {
        host: address,
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...withoutHopByHop(req.headers), host: target.host },
        timeout: 30000,
        // One connection per request: nothing stays pooled past the response or the browser.
        agent: false,
      },
      (response) => {
        try {
          res.writeHead(response.statusCode, withoutHopByHop(response.headers));
        } catch {
          upstream.destroy();
          return failUpstream(res);
        }
        response.pipe(res);
      },
    );
    upstream.on('socket', track);
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      upstream.destroy();
      failUpstream(res);
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req, socket) => {
    track(socket);
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
    let address;
    try {
      address = await resolve(target.hostname);
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(target.port || 443), address);
    track(upstream);
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
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
