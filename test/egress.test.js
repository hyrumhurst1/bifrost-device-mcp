// Tests for the loopback egress proxy that every browser request, including redirect hops, crosses.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startEgressProxy } from '../src/egress.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t) {
  const hits = [];
  const target = await listen((req, res) => {
    hits.push(req.url);
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
      return res.end();
    }
    res.end('hello from target');
  });
  const allowed = new Set([target.origin]);
  const proxy = await startEgressProxy((url) => {
    try {
      return allowed.has(new URL(url).origin);
    } catch {
      return false;
    }
  });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => target.server.close(resolve));
  });
  return { proxy, target: target.origin, hits };
}

function proxiedGet(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: url },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function connectStatus(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.once('data', (data) => {
      resolve(data.toString('latin1').split('\r\n')[0]);
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

test('Egress proxy listens on loopback only', async (t) => {
  const { proxy } = await fixture(t);
  assert.equal(proxy.address().address, '127.0.0.1');
});

test('Egress proxy forwards approved origins and passes redirects back unfollowed', async (t) => {
  const { proxy, target, hits } = await fixture(t);
  const ok = await proxiedGet(proxy.address().port, `${target}/page`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'hello from target');
  const redirect = await proxiedGet(proxy.address().port, `${target}/redirect`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, 'http://127.0.0.1:9/elsewhere');
  assert.deepEqual(hits, ['/page', '/redirect']);
});

test('Egress proxy refuses unapproved origins without contacting them', async (t) => {
  const { proxy, hits } = await fixture(t);
  const port = proxy.address().port;
  for (const url of ['http://127.0.0.1:9/', 'http://localhost:1/', '/relative', 'ftp://127.0.0.1/'])
    assert.equal((await proxiedGet(port, url)).status, 403);
  assert.deepEqual(hits, []);
});

test('Egress proxy refuses CONNECT tunnels to unapproved origins', async (t) => {
  const { proxy, target } = await fixture(t);
  const port = proxy.address().port;
  assert.match(await connectStatus(port, 'example.com:443'), / 403 /);
  assert.match(await connectStatus(port, new URL(target).host), / 403 /);
});

test('Egress proxy tunnels CONNECT only to an approved HTTPS origin', async (t) => {
  const tunnelled = net.createServer((socket) => socket.end());
  await new Promise((resolve) => tunnelled.listen(0, '127.0.0.1', resolve));
  const authority = `127.0.0.1:${tunnelled.address().port}`;
  const proxy = await startEgressProxy((url) => new URL(url).origin === `https://${authority}`);
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => tunnelled.close(resolve));
  });
  assert.match(await connectStatus(proxy.address().port, authority), / 200 /);
});

test('Egress proxy survives an approved server sending an invalid status line', async (t) => {
  const connections = new Set();
  const raw = net.createServer((socket) => {
    connections.add(socket);
    socket.end('HTTP/1.1 000 Zero\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${raw.address().port}`;
  const proxy = await startEgressProxy((url) => new URL(url).origin === origin);
  t.after(async () => {
    await proxy.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => raw.close(resolve));
  });
  assert.equal((await proxiedGet(proxy.address().port, `${origin}/`)).status, 502);
  assert.equal((await proxiedGet(proxy.address().port, 'http://127.0.0.1:9/')).status, 403);
});

test('Egress proxy pins each hostname to its first DNS answer', async (t) => {
  const target = await listen((req, res) => res.end(`host=${req.headers.host}`));
  const port = new URL(target.origin).port;
  const answers = ['127.0.0.1', '10.255.255.1'];
  const lookups = [];
  const lookup = async (hostname) => {
    lookups.push(hostname);
    return { address: answers[lookups.length - 1], family: 4 };
  };
  const approved = `http://rebind.test:${port}`;
  const proxy = await startEgressProxy((url) => new URL(url).origin === approved, { lookup });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => target.server.close(resolve));
  });
  for (let i = 0; i < 2; i++) {
    const response = await proxiedGet(proxy.address().port, `${approved}/page`);
    assert.equal(response.status, 200);
    assert.equal(response.body, `host=rebind.test:${port}`);
  }
  assert.deepEqual(lookups, ['rebind.test']);
});
