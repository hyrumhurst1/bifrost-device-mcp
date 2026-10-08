// Real-Chromium regression tests for the isolated browser. Requires a Playwright Chromium with a
// working sandbox; a launch failure fails these tests rather than skipping them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../src/bridge.js';
import { Policy } from '../src/policy.js';
import { createServer } from '../src/server.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function browserFixture(t) {
  const blockedHits = [];
  const blocked = await listen((req, res) => {
    blockedHits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<title>Private service</title><p>private-service-content</p>');
  });
  const allowed = await listen((req, res) => {
    const redirects = {
      '/to-blocked': `${blocked.origin}/navigated`,
      '/image-to-blocked': `${blocked.origin}/image`,
      '/hop': '/final',
    };
    if (redirects[req.url]) {
      res.writeHead(302, { location: redirects[req.url] });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/subresources')
      res.end(
        `<title>Subresources</title><img src="${blocked.origin}/direct"><img src="/image-to-blocked"><p>page</p>`,
      );
    else res.end(`<title>Allowed</title><p>allowed-content at ${req.url}</p>`);
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-browser-test-'));
  const bridge = await new Bridge({
    workspace: dir,
    origins: [allowed.origin],
    executablePath: process.env.BIFROST_CHROMIUM_EXECUTABLE,
  }).init();
  t.after(async () => {
    await bridge.close();
    await Promise.all([allowed, blocked].map(({ server }) => new Promise((r) => server.close(r))));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, allowed: allowed.origin, blocked: blocked.origin, blockedHits };
}

async function processesWithHome(home) {
  const found = [];
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const environ = (await fs.readFile(`/proc/${pid}/environ`)).toString('utf8').split('\0');
      if (environ.includes(`HOME=${home}`))
        found.push((await fs.readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0'));
    } catch {
      // Processes exit or belong to other users while we scan.
    }
  }
  return found;
}

test('Redirects to unapproved origins are blocked before any request leaves', async (t) => {
  const { bridge, allowed, blocked, blockedHits } = await browserFixture(t);
  await assert.rejects(bridge.browserAction('navigate', { url: `${allowed}/to-blocked` }));
  assert.deepEqual(blockedHits, []);
  const page = await bridge.browserAction('snapshot', {}).catch((error) => ({ error }));
  assert.ok(!JSON.stringify(page).includes('private-service-content'));
  assert.ok(!String(page.url ?? '').startsWith(blocked));
});

test('Subresources and their redirects cannot reach unapproved origins', async (t) => {
  const { bridge, allowed, blockedHits } = await browserFixture(t);
  const page = await bridge.browserAction('navigate', { url: `${allowed}/subresources` });
  assert.equal(page.title, 'Subresources');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(blockedHits, []);
});

test('Redirects within an approved origin still work', async (t) => {
  const { bridge, allowed } = await browserFixture(t);
  const page = await bridge.browserAction('navigate', { url: `${allowed}/hop` });
  assert.equal(page.url, `${allowed}/final`);
  assert.match(page.text, /allowed-content at \/final/);
});

test('Browser runs sandboxed in a temporary home and leaves nothing behind', async (t) => {
  const { bridge, allowed } = await browserFixture(t);
  await bridge.browserAction('navigate', { url: allowed });
  const home = bridge.browserHome;
  const processes = await processesWithHome(home);
  assert.ok(processes.length > 0, 'browser processes are visible');
  const main = processes.find((argv) => argv.some((arg) => arg.startsWith('--proxy-server=')));
  assert.ok(main, 'browser traffic is sent through the egress proxy');
  assert.ok(
    main.some((arg) => arg.startsWith('--proxy-bypass-list=') && arg.includes('<-loopback>')),
  );
  for (const argv of processes)
    for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--no-zygote-sandbox'])
      assert.ok(!argv.includes(flag), `browser launched with ${flag}`);
  await bridge.close();
  assert.deepEqual(await processesWithHome(home), []);
  await assert.rejects(fs.stat(home));
});

async function siteWithClient(t, pages) {
  const hits = [];
  const site = await listen((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end(pages[req.url] ?? '<title>Plain</title><p>plain page</p>');
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-browser-mcp-'));
  const bridge = await new Bridge({
    workspace: dir,
    origins: [site.origin],
    executablePath: process.env.BIFROST_CHROMIUM_EXECUTABLE,
  }).init();
  const server = createServer(bridge, new Policy({ mode: 'auto' }));
  const client = new Client({ name: 'browser-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    await bridge.close();
    await new Promise((resolve) => site.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, client, origin: site.origin, hits };
}

test('A click cannot land on a page that replaced the one it was requested for', async (t) => {
  const { client, origin, hits } = await siteWithClient(t, {
    '/a': `<title>A</title><button id="ok" style="display:none">A</button>
      <script>setTimeout(() => { location = '/b'; }, 300)</script>`,
    '/b': `<title>B</title><button id="ok" onclick="fetch('/clicked')">B</button>`,
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/a` } });
  const result = await client.callTool({ name: 'browser_click', arguments: { selector: '#ok' } });
  assert.equal(result.isError, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!hits.includes('/clicked'), JSON.stringify(hits));
});

test('Selectors cannot reach into frames outside the approved document binding', async (t) => {
  const { client, origin } = await siteWithClient(t, {
    '/framed': `<title>Framed</title><iframe src="/inner"></iframe>`,
    '/inner': `<title>Inner</title><button id="x">x</button>`,
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/framed` } });
  const result = await client.callTool({
    name: 'browser_click',
    arguments: { selector: 'iframe >> internal:control=enter-frame >> #x' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /frame/i);
});

test('A page that hangs its renderer is released instead of wedging the browser', async (t) => {
  const { bridge, origin } = await siteWithClient(t, {
    '/busy': `<title>Busy</title><script>setTimeout(() => { for (;;) {} }, 50)</script>`,
  });
  await bridge.browserAction('navigate', { url: `${origin}/busy` }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  await assert.rejects(bridge.browserAction('snapshot', {}), /stopped responding/);
  assert.ok(Date.now() - started < 15000);
  assert.equal(bridge.browser, null);
  const page = await bridge.browserAction('navigate', { url: `${origin}/plain` });
  assert.equal(page.title, 'Plain');
});
