// Tests for the local owner console: approvals, mode changes and safe display of agent text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Policy } from '../src/policy.js';
import { attachApprovalConsole, formatPending } from '../src/console.js';

function consoleFixture(t, mode = 'ask') {
  const policy = new Policy({ mode });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => (written += chunk));
  const owner = attachApprovalConsole(policy, { input, output });
  t.after(() => owner.close());
  const send = async (line) => {
    const before = written.length;
    input.write(line + '\n');
    await new Promise((resolve) => setImmediate(resolve));
    return written.slice(before);
  };
  return { policy, send };
}

const PRINTABLE_ASCII = /^[\x20-\x7e\n]*$/;

test('Pending requests are shown with agent text escaped for the terminal', () => {
  const value = ['safe', '\x1b[2J', 'evil', '\x9b31m']
    .concat([0x202e, 0x200b, 0x2066].map((code) => String.fromCodePoint(code)))
    .join('');
  const shown = formatPending(
    [{ id: 'r1', tool: 'browser_fill', args: { value }, approved: false, expiresAt: 61000 }],
    1000,
  );
  assert.ok(PRINTABLE_ASCII.test(shown), JSON.stringify(shown));
  assert.match(shown, /\\u202e/);
  assert.match(shown, /\\u001b/);
  assert.match(shown, /"expiresInSeconds": 60/);
});

test('Owner console lists, approves once and changes mode locally', async (t) => {
  const { policy, send } = consoleFixture(t);
  const request = policy.authorize('terminal_run', { task: 'version', cwd: '.' });
  assert.match(await send('pending'), new RegExp(request.requestId));
  assert.match(await send(`approve ${request.requestId}`), /Approved once/);
  assert.equal(
    policy.authorize('terminal_run', { task: 'version', cwd: '.' }, request.requestId),
    null,
  );
  assert.match(await send('mode auto'), /Mode auto/);
  assert.equal(policy.mode, 'auto');
});

test('Owner console refuses bypass, unknown requests and unknown commands', async (t) => {
  const { policy, send } = consoleFixture(t);
  assert.match(await send('mode bypass'), /unsupported/i);
  assert.equal(policy.mode, 'ask');
  assert.match(await send('approve 00000000-0000-4000-8000-000000000000'), /Unknown or expired/);
  assert.match(await send('grant everything'), /Unknown command/);
});
