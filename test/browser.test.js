// Real-Chromium regression tests for the isolated browser. Requires a Playwright Chromium with a
// working sandbox; a launch failure fails these tests rather than skipping them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';

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
