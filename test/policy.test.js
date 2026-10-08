import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy } from '../src/policy.js';
test('Auto is default; agent can only reduce', () => {
  const p = new Policy();
  assert.equal(p.authorize('read', {}), null);
  p.reduce();
  assert.equal(p.mode, 'ask');
  assert.equal(p.authorize('read', {}).status, 'approval_required');
});
test('Bypass cannot be activated', () => {
  assert.throws(() => new Policy({ mode: 'bypass' }));
  assert.throws(() => new Policy().setLocal('bypass'));
});
test('Approvals are bound to action, single-use, and expire', () => {
  let now = 0;
  const p = new Policy({ mode: 'ask', ttlMs: 10, now: () => now });
  const r = p.authorize('run', { task: 'version' });
  p.approveLocal(r.requestId);
  assert.throws(() => p.authorize('run', { task: 'other' }, r.requestId));
  const s = p.authorize('run', {});
  p.approveLocal(s.requestId);
  assert.equal(p.authorize('run', {}, s.requestId), null);
  assert.throws(() => p.authorize('run', {}, s.requestId));
  const t = p.authorize('run', {});
  p.approveLocal(t.requestId);
  now = 11;
  assert.throws(() => p.authorize('run', {}, t.requestId));
});
test('Forged consent and mode transitions invalidate approvals', () => {
  const p = new Policy({ mode: 'ask' });
  const r = p.authorize('run', {});
  assert.throws(() => p.authorize('run', {}, r.requestId));
  const s = p.authorize('run', {});
  p.approveLocal(s.requestId);
  p.reduce();
  assert.throws(() => p.authorize('run', {}, s.requestId));
  p.setLocal('auto');
  assert.equal(p.mode, 'auto');
});
test('Concurrent approval attempts consume once', async () => {
  const p = new Policy({ mode: 'ask' });
  const r = p.authorize('x', {});
  p.approveLocal(r.requestId);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => p.authorize('x', {}, r.requestId)),
    Promise.resolve().then(() => p.authorize('x', {}, r.requestId)),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
});
test('Approval queue is bounded', () => {
  const p = new Policy({ mode: 'ask' });
  for (let i = 0; i < 100; i++) p.authorize('x', { i });
  assert.throws(() => p.authorize('x', {}));
});
test('Retrying before the owner approves keeps the request pending', () => {
  const p = new Policy({ mode: 'ask' });
  const r = p.authorize('run', { task: 'version' });
  assert.throws(() => p.authorize('run', { task: 'version' }, r.requestId), /waiting/);
  assert.equal(p.pendingLocal().length, 1);
  p.approveLocal(r.requestId);
  assert.equal(p.authorize('run', { task: 'version' }, r.requestId), null);
  assert.throws(() => p.authorize('run', { task: 'version' }, r.requestId));
});
test('An unapproved request cannot be redirected to another action', () => {
  const p = new Policy({ mode: 'ask' });
  const r = p.authorize('run', { task: 'version' });
  assert.throws(() => p.authorize('run', { task: 'other' }, r.requestId), /invalid/);
  assert.throws(() => p.approveLocal(r.requestId), /Unknown/);
});
