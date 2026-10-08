import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
async function fixture(t, recipes = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-test-'));
  const root = path.join(dir, 'workspace');
  await fs.mkdir(root);
  const bridge = await new Bridge({
    workspace: root,
    recipes,
    auditFile: path.join(dir, 'audit.jsonl'),
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, dir, root };
}
test('Read/list bound to real workspace, symlink escape rejected', async (t) => {
  const { bridge, root, dir } = await fixture(t);
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello');
  await fs.writeFile(path.join(dir, 'secret'), 'do not read');
  await fs.symlink(path.join(dir, 'secret'), path.join(root, 'escape'));
  assert.equal((await bridge.read('hello.txt')).text, 'hello');
  assert.equal((await bridge.list('.')).entries.length, 2);
  for (const p of ['../secret', '/etc/passwd', 'escape', '\0'])
    await assert.rejects(bridge.read(p));
});
test('File reads truncate and reject directories', async (t) => {
  const { bridge, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'large'), 'x'.repeat(40000));
  assert.equal((await bridge.read('large')).text.length, 32768);
  assert.equal((await bridge.read('large')).truncated, true);
  await assert.rejects(bridge.read('.'));
});
test('Unknown, prototype and unapproved commands fail', async (t) => {
  const { bridge } = await fixture(t);
  for (const task of ['sh', 'constructor', '__proto__'])
    await assert.rejects(bridge.run(task, '.'));
});
test('Approved exact executable executes, env secrets absent', async (t) => {
  const { bridge } = await fixture(t, {
    env: {
      executable: process.execPath,
      args: ['-e', 'console.log(process.env.BIFROST_TEST_SECRET ?? "clean")'],
    },
  });
  process.env.BIFROST_TEST_SECRET = 'sensitive-test-marker';
  const r = await bridge.run('env', '.');
  assert.equal(r.code, 0);
  assert.equal(r.output.trim(), 'clean');
  delete process.env.BIFROST_TEST_SECRET;
});
test('Shell syntax is literal argument, never interpolated', async (t) => {
  const { bridge } = await fixture(t, {
    literal: {
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', '$(touch injected); echo hacked'],
    },
  });
  assert.equal((await bridge.run('literal', '.')).output.trim(), '$(touch injected); echo hacked');
});
test('Execution output and runtime bounded', async (t) => {
  const { bridge } = await fixture(t, {
    noise: {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(1000000))'],
    },
    wait: {
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 100,
    },
  });
  const noise = await bridge.run('noise', '.');
  assert.equal(noise.truncated, true);
  assert.equal(Buffer.byteLength(noise.output), 32768);
  const wait = await bridge.run('wait', '.');
  assert.equal(wait.reason, 'timeout');
  assert.equal(bridge.children.size, 0);
});
test('Cancellation terminates command', async (t) => {
  const { bridge } = await fixture(t, {
    wait: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
  });
  const controller = new AbortController();
  const result = bridge.run('wait', '.', controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await result).reason, 'cancelled');
});
test('Audit receipts omit raw data; error paths audited', async (t) => {
  const { bridge, dir } = await fixture(t);
  await bridge.invoke('test', async () => ({ output: 'secret-content' }));
  await assert.rejects(
    bridge.invoke('fail', async () => {
      throw Error('secret-error');
    }),
  );
  const log = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(!log.includes('secret'));
  assert.equal(log.trim().split('\n').length, 2);
});
test('Browser origin filtering rejects schemes, userinfo, alternate hosts', async (t) => {
  const { bridge } = await fixture(t);
  bridge.origins.add('http://127.0.0.1:1234');
  assert.equal(bridge.allowed('http://127.0.0.1:1234/path'), true);
  for (const u of [
    'file:///etc/passwd',
    'http://localhost:1234',
    'http://u:p@127.0.0.1:1234',
    'https://example.com',
    'javascript:alert(1)',
  ])
    assert.equal(bridge.allowed(u), false);
});
test('Closed bridge rejects further work', async (t) => {
  const { bridge } = await fixture(t);
  await bridge.close();
  await assert.rejects(bridge.invoke('test', async () => ({})));
});
test('Failed audit does not misreport a completed action as failed', async (t) => {
  const { bridge, dir } = await fixture(t);
  bridge.auditFile = path.join(dir, 'missing', 'audit');
  let count = 0;
  const result = await bridge.invoke('write', async () => ({ count: ++count }));
  assert.equal(result.count, 1);
  assert.equal(result.receipt.auditRecorded, false);
});
test('Workspace executables are rejected', async (t) => {
  const { bridge, root } = await fixture(t);
  const executable = path.join(root, 'script');
  await fs.writeFile(executable, '#!/bin/sh\necho hi', { mode: 0o755 });
  bridge.recipes.script = { executable, args: [] };
  await assert.rejects(bridge.run('script', '.'));
});
test('Descriptor-relative reads refuse symlink ancestors', async (t) => {
  const { bridge, root, dir } = await fixture(t);
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside', 'file'), 'outside');
  await fs.symlink(path.join(dir, 'outside'), path.join(root, 'a'));
  await assert.rejects(bridge.read('a/file'));
});
test('FIFO reads fail promptly without blocking workers', async (t) => {
  const { bridge, root } = await fixture(t);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) =>
    execFile('/usr/bin/mkfifo', [path.join(root, 'pipe')], (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  const start = Date.now();
  await assert.rejects(bridge.read('pipe'));
  assert.ok(Date.now() - start < 1000);
});
test('Terminal admission is capped before asynchronous validation', async (t) => {
  const { bridge } = await fixture(t, {
    wait: { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},300)'] },
  });
  const pending = Array.from({ length: 4 }, () => bridge.run('wait', '.'));
  await assert.rejects(bridge.run('wait', '.'));
  await Promise.all(pending);
  assert.equal(bridge.running, 0);
});
test('Session status exposes health without device paths or secrets', async (t) => {
  const { bridge, root } = await fixture(t);
  const first = bridge.status('ask');
  assert.equal(first.mode, 'ask');
  assert.equal(first.persistence, 'process_only');
  assert.equal(first.lifecycle, 'running');
  assert.ok(!JSON.stringify(first).includes(root));
  assert.equal(bridge.status().sessionId, first.sessionId);
  await bridge.close();
  assert.equal(bridge.status().lifecycle, 'closed');
});
test('Recent receipts are bounded, copied and contain no command output', async (t) => {
  const { bridge } = await fixture(t);
  for (let i = 0; i < 105; i++)
    await bridge.invoke('fixture', async () => ({ output: 'private-content-' + i }));
  const result = bridge.recentReceipts(100);
  assert.equal(result.receipts.length, 100);
  assert.ok(!JSON.stringify(result).includes('private-content'));
  result.receipts[0].tool = 'tampered';
  assert.equal(bridge.recentReceipts(100).receipts[0].tool, 'fixture');
  assert.throws(() => bridge.recentReceipts(101));
  assert.throws(() => bridge.recentReceipts(0));
});
test('A workspace at the filesystem root still refuses workspace executables', async (t) => {
  const bridge = await new Bridge({
    workspace: '/',
    recipes: { version: { executable: process.execPath, args: ['--version'] } },
  }).init();
  t.after(() => bridge.close());
  await assert.rejects(bridge.run('version', '.'), /inside the workspace/);
});
test('Command errors do not reveal absolute device paths', async (t) => {
  const { bridge, root } = await fixture(t, {
    version: { executable: process.execPath, args: ['--version'] },
    missing: { executable: '/nonexistent/bifrost-test-binary', args: [] },
  });
  const messages = [];
  for (const [task, cwd] of [
    ['version', 'no-such-directory'],
    ['missing', '.'],
  ])
    await bridge.run(task, cwd).then(
      () => assert.fail(`${task} should fail`),
      (error) => messages.push(error.message),
    );
  for (const message of messages) {
    assert.ok(!message.includes(root), message);
    assert.ok(!message.includes('/nonexistent'), message);
  }
});
