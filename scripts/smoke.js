import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-smoke-'));
const workspace = path.join(dir, 'workspace');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'hello.txt'), 'Synthetic fixture, no personal data.');
const policy = path.join(dir, 'policy.json');
await fs.writeFile(
  policy,
  JSON.stringify({ tasks: { version: { executable: process.execPath, args: ['--version'] } } }),
);
let blockedRequests = 0;
const blocked = http.createServer((req, res) => {
  blockedRequests++;
  res.end('not allowed');
});
await new Promise((r) => blocked.listen(0, '127.0.0.1', r));
const blockedUrl = `http://127.0.0.1:${blocked.address().port}`;
const fixture = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: blockedUrl });
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(
    `<!doctype html><title>Bifrost demo</title><h1>Local fixture</h1><label>Name<input id="name"></label><button id="greet" onclick="document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Greet</button><p id="result">Waiting</p><img src="${blockedUrl}/leak">`,
  );
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const chromium = process.env.BIFROST_CHROMIUM_EXECUTABLE;
const env = {
  ...process.env,
  BIFROST_WORKSPACE: workspace,
  BIFROST_POLICY: policy,
  BIFROST_BROWSER_ORIGINS: JSON.stringify([origin]),
  BIFROST_MODE: 'auto',
  BIFROST_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
};
if (chromium) env.BIFROST_CHROMIUM_EXECUTABLE = chromium;
let child;
const clients = [];
const parse = (r) => JSON.parse(r.content.find((x) => x.type === 'text').text);
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return parse(result);
}
try {
  const stdio = new Client({ name: 'bifrost-smoke', version: '1.0.0' });
  clients.push(stdio);
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repo, 'src/cli.js')],
      env,
      stderr: 'pipe',
    }),
  );
  const tools = await stdio.listTools();
  assert.equal(tools.tools.length, 12);
  assert.match((await call(stdio, 'workspace_read', { path: 'hello.txt' })).text, /Synthetic/);
  assert.match((await call(stdio, 'terminal_run', { task: 'version' })).output, /^v/);
  assert.equal(
    (await stdio.callTool({ name: 'workspace_read', arguments: { path: '../policy.json' } }))
      .isError,
    true,
  );
  if (process.env.BIFROST_SKIP_BROWSER === '1') {
    console.log('SKIP browser E2E explicitly requested; not a full smoke pass');
  } else {
    await call(stdio, 'browser_navigate', { url: origin });
    await call(stdio, 'browser_fill', { selector: '#name', value: 'MCP' });
    await call(stdio, 'browser_click', { selector: '#greet' });
    assert.match((await call(stdio, 'browser_snapshot')).text, /Hello MCP/);
    const screenshot = await stdio.callTool({ name: 'browser_screenshot', arguments: {} });
    assert.equal(screenshot.content[0].type, 'image');
    assert.ok(screenshot.content[0].data.length > 1000);
    assert.equal(
      (await stdio.callTool({ name: 'browser_navigate', arguments: { url: blockedUrl } })).isError,
      true,
    );
    assert.equal(
      (await stdio.callTool({ name: 'browser_navigate', arguments: { url: origin + '/redirect' } }))
        .isError,
      true,
    );
    assert.equal(blockedRequests, 0);
  }
  const status = await call(stdio, 'session_status');
  assert.equal(status.mode, 'auto');
  assert.equal(status.persistence, 'process_only');
  const receipts = await call(stdio, 'recent_receipts', { limit: 2 });
  assert.ok(receipts.receipts.length > 0);
  assert.equal(receipts.sessionId, status.sessionId);
  await call(stdio, 'permissions_reduce');
  assert.equal((await call(stdio, 'session_status')).mode, 'ask');
  assert.equal(
    (await call(stdio, 'terminal_run', { task: 'version' })).status,
    'approval_required',
  );
  console.log(
    'PASS stdio MCP: handshake, tools, terminal, files, Ask mode' +
      (process.env.BIFROST_SKIP_BROWSER === '1'
        ? ' (browser unverified)'
        : ', browser fill/click/screenshot and origin/subresource/redirect blocking'),
  );
  // Test-only public fixture token, not a generated or provisioned access credential.
  const token = 'synthetic-test-only-not-a-secret-000000000';
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  child = spawn(process.execPath, [path.join(repo, 'src/cli.js')], {
    env: {
      ...env,
      BIFROST_TRANSPORT: 'http',
      BIFROST_PORT: String(port),
      BIFROST_HTTP_TOKEN: token,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(ready, true, 'HTTP server starts');
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (
      await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      const request = http.request(
        url,
        { headers: { Authorization: `Bearer ${token}`, Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    }),
    403,
  );
  const remote = new Client({ name: 'http-smoke', version: '1.0.0' });
  clients.push(remote);
  await remote.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  assert.match((await call(remote, 'terminal_run', { task: 'version' })).output, /^v/);
  const session = await call(remote, 'session_status');
  const reconnect = new Client({ name: 'http-reconnect', version: '1.0.0' });
  clients.push(reconnect);
  await reconnect.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  assert.equal((await call(reconnect, 'session_status')).sessionId, session.sessionId);
  assert.ok((await call(reconnect, 'recent_receipts')).receipts.length > 0);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: 'x'.repeat(70000),
      })
    ).status,
    413,
  );
  console.log(
    'PASS loopback HTTP MCP: handshake, authenticated command, missing auth, Host/Origin, body size guards',
  );
} finally {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 2000).unref();
    });
  }
  await Promise.all([fixture, blocked].map((s) => new Promise((r) => s.close(r))));
  await fs.rm(dir, { recursive: true, force: true });
}
