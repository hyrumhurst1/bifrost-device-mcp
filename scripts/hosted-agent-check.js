// End-to-end check of the authenticated loopback HTTP transport the way a hosted agent calls it:
// raw JSON-RPC over Streamable HTTP with a bearer token, Ask mode, and approvals granted from a
// real owner console on a pseudo-terminal. Synthetic fixtures only; Linux with util-linux script.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-agent-check-'));
const workspace = path.join(dir, 'workspace');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'hello.txt'), 'Synthetic fixture, no personal data.');
const policyFile = path.join(dir, 'policy.json');
await fs.writeFile(
  policyFile,
  JSON.stringify({ tasks: { version: { executable: process.execPath, args: ['--version'] } } }),
  { mode: 0o600 },
);
// Test-only public fixture token, not a generated or provisioned access credential.
const token = 'synthetic-test-only-not-a-secret-000000000';
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const endpoint = `http://127.0.0.1:${port}/mcp`;

// util-linux script gives the bridge a pseudo-terminal as its controlling terminal, so the owner
// console reads /dev/tty exactly as it would in the operator's own shell.
const owner = spawn('script', ['-qfec', 'exec "$BIFROST_NODE" "$BIFROST_CLI"', '/dev/null'], {
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8',
    BIFROST_NODE: process.execPath,
    BIFROST_CLI: path.join(repo, 'src/cli.js'),
    BIFROST_WORKSPACE: workspace,
    BIFROST_POLICY: policyFile,
    BIFROST_BROWSER_ORIGINS: '[]',
    BIFROST_MODE: 'ask',
    BIFROST_APPROVAL_CONSOLE: '1',
    BIFROST_TRANSPORT: 'http',
    BIFROST_PORT: String(port),
    BIFROST_HTTP_TOKEN: token,
  },
});
let terminal = '';
owner.stdout.on('data', (chunk) => (terminal += chunk));
owner.stderr.on('data', (chunk) => (terminal += chunk));

async function waitFor(pattern, from = 0) {
  for (let i = 0; i < 100; i++) {
    if (pattern.test(terminal.slice(from))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Owner terminal never showed ${pattern}:\n${terminal}`);
}

async function ownerTypes(line, expected) {
  const from = terminal.length;
  owner.stdin.write(`${line}\n`);
  await waitFor(expected, from);
}

let nextId = 1;
async function rpc(method, params, { auth = `Bearer ${token}`, notification = false } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (auth) headers.authorization = auth;
  const body = { jsonrpc: '2.0', method, params };
  if (!notification) body.id = nextId++;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return {
    status: response.status,
    json: text && response.status === 200 ? JSON.parse(text) : null,
  };
}

async function callTool(name, args = {}) {
  const { status, json } = await rpc('tools/call', { name, arguments: args });
  assert.equal(status, 200);
  const result = json.result;
  const text = result.content.find((item) => item.type === 'text')?.text ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: result.isError === true, text, data };
}

try {
  await waitFor(/Bifrost owner console/);
  await waitFor(/listening on loopback port/);

  assert.equal((await rpc('tools/list', {}, { auth: null })).status, 401);
  assert.equal(
    (await rpc('tools/list', {}, { auth: `Bearer ${'x'.repeat(token.length)}` })).status,
    401,
  );
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hosted-agent-check', version: '1.0.0' },
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'bifrost-device-mcp');
  assert.ok(
    [200, 202].includes(
      (await rpc('notifications/initialized', {}, { notification: true })).status,
    ),
  );
  const tools = (await rpc('tools/list', {})).json.result.tools.map((tool) => tool.name);
  assert.equal(tools.length, 12);
  assert.ok(!tools.some((name) => /raise|approve|bypass|mode/.test(name)));
  console.log(
    'PASS hosted-agent HTTP: bearer auth enforced, initialize, 12 tools, no elevation tool',
  );

  const request = await callTool('terminal_run', { task: 'version', approved: true });
  assert.equal(request.data.status, 'approval_required');
  assert.equal(request.data.args.approved, undefined);
  const early = await callTool('terminal_run', {
    task: 'version',
    approvalId: request.data.requestId,
  });
  assert.equal(early.isError, true);
  assert.match(early.text, /waiting for the owner/);
  const receiptsBefore = (await callTool('recent_receipts', { limit: 100 })).data.receipts;
  assert.ok(!receiptsBefore.some((receipt) => receipt.tool === 'terminal_run'));
  console.log(
    'PASS Ask mode: action queued, agent-supplied approval and early retry do not run it',
  );

  await ownerTypes('pending', new RegExp(request.data.requestId));
  await ownerTypes(`approve ${request.data.requestId}`, /"tool": "terminal_run"[\s\S]*Type yes/);
  await ownerTypes('yes', /Approved once/);
  const approved = await callTool('terminal_run', {
    task: 'version',
    approvalId: request.data.requestId,
  });
  assert.equal(approved.isError, false, approved.text);
  assert.match(approved.data.output, /^v\d+/);
  const replay = await callTool('terminal_run', {
    task: 'version',
    approvalId: request.data.requestId,
  });
  assert.equal(replay.isError, true);
  const other = await callTool('workspace_read', { path: 'hello.txt' });
  assert.equal(other.data.status, 'approval_required');
  await ownerTypes(`approve ${other.data.requestId}`, /Type yes/);
  await ownerTypes('yes', /Approved once/);
  const swapped = await callTool('workspace_read', {
    path: '../policy.json',
    approvalId: other.data.requestId,
  });
  assert.equal(swapped.isError, true);
  assert.match(swapped.text, /invalid/);
  console.log(
    'PASS owner console: local approval runs the exact action once; replay and swapped arguments refused',
  );

  await ownerTypes('mode auto', /Mode auto/);
  assert.match((await callTool('terminal_run', { task: 'version' })).data.output, /^v\d+/);
  assert.equal((await callTool('permissions_reduce')).data.mode, 'ask');
  assert.equal(
    (await callTool('terminal_run', { task: 'version' })).data.status,
    'approval_required',
  );
  assert.equal((await callTool('session_status')).data.mode, 'ask');
  console.log(
    'PASS modes: owner raises to Auto locally; agent reduces to Ask and cannot raise it back',
  );
} finally {
  try {
    process.kill(-owner.pid, 'SIGTERM');
  } catch {
    // Already exited.
  }
  await new Promise((resolve) => {
    if (owner.exitCode !== null || owner.signalCode !== null) return resolve();
    owner.once('exit', resolve);
    setTimeout(() => {
      try {
        process.kill(-owner.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
      resolve();
    }, 3000).unref();
  });
  await fs.rm(dir, { recursive: true, force: true });
}
