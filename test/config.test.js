// Tests for launch configuration: workspace, policy, origin and audit checks that fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isInside, loadConfig } from '../src/config.js';

async function fixture(
  t,
  tasks = { version: { executable: process.execPath, args: ['--version'] } },
) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-config-')));
  const workspace = path.join(dir, 'workspace');
  const installation = path.join(dir, 'installation');
  const policy = path.join(dir, 'policy.json');
  await fs.mkdir(workspace);
  await fs.mkdir(installation);
  await fs.writeFile(policy, JSON.stringify({ tasks }), { mode: 0o600 });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { BIFROST_WORKSPACE: workspace, BIFROST_POLICY: policy };
  return { dir, workspace, installation, policy, env };
}

test('Containment holds for the filesystem root and sibling prefixes', () => {
  assert.equal(isInside('/', '/home/user/bifrost'), true);
  assert.equal(isInside('/srv/work', '/srv/work'), true);
  assert.equal(isInside('/srv/work', '/srv/work/a/b'), true);
  assert.equal(isInside('/srv/work', '/srv/workspace'), false);
  assert.equal(isInside('/srv/work', '/srv'), false);
  assert.equal(isInside('/srv/work', '/srv/work/..data'), true);
});

test('A valid configuration loads with validated recipes and origins', async (t) => {
  const { env, workspace, installation } = await fixture(t);
  const config = await loadConfig(
    { ...env, BIFROST_BROWSER_ORIGINS: '["http://127.0.0.1:8080"]' },
    installation,
  );
  assert.equal(config.workspace, workspace);
  assert.deepEqual(Object.keys(config.recipes), ['version']);
  assert.deepEqual(config.origins, ['http://127.0.0.1:8080']);
  assert.equal(config.mode, 'auto');
});

test('Native Windows fails closed at startup', async (t) => {
  const { env, installation } = await fixture(t);
  await assert.rejects(loadConfig(env, installation, 'win32'), /Windows is unsupported/);
});

test('A workspace at the filesystem root is refused', async (t) => {
  const { env, installation } = await fixture(t);
  await assert.rejects(
    loadConfig({ ...env, BIFROST_WORKSPACE: '/' }, installation),
    /installation/,
  );
});

test('A workspace that contains the installation is refused', async (t) => {
  const { env, dir, installation } = await fixture(t);
  await assert.rejects(
    loadConfig({ ...env, BIFROST_WORKSPACE: dir }, installation),
    /installation/,
  );
});

test('A policy inside the workspace is refused', async (t) => {
  const { env, workspace, installation } = await fixture(t);
  const inside = path.join(workspace, 'policy.json');
  await fs.writeFile(inside, '{"tasks":{}}', { mode: 0o600 });
  await assert.rejects(loadConfig({ ...env, BIFROST_POLICY: inside }, installation), /outside/);
});

test('A policy writable by group or others is refused', async (t) => {
  const { env, policy, installation } = await fixture(t);
  await fs.chmod(policy, 0o664);
  await assert.rejects(loadConfig(env, installation), /writable/);
  await fs.chmod(policy, 0o646);
  await assert.rejects(loadConfig(env, installation), /writable/);
});

test('Malformed recipes are refused at startup', async (t) => {
  const bad = [
    { relative: { executable: 'node', args: [] } },
    { args: { executable: process.execPath, args: ['--version', 1] } },
    { noArgs: { executable: process.execPath } },
    { timeout: { executable: process.execPath, args: [], timeoutMs: 'soon' } },
    { slow: { executable: process.execPath, args: [], timeoutMs: 60000 } },
    { extra: { executable: process.execPath, args: [], cwd: '/' } },
    { 'bad name!': { executable: process.execPath, args: [] } },
  ];
  for (const tasks of bad) {
    const { env, installation } = await fixture(t, tasks);
    await assert.rejects(loadConfig(env, installation), /recipe|task/i, JSON.stringify(tasks));
  }
  const { env, installation } = await fixture(t, ['not', 'an', 'object']);
  await assert.rejects(loadConfig(env, installation), /tasks/);
});

test('Browser origins must be exact HTTP(S) origins', async (t) => {
  const { env, installation } = await fixture(t);
  for (const origins of [
    '"http://127.0.0.1"',
    '["http://127.0.0.1/"]',
    '["file:///etc"]',
    '["http://u:p@127.0.0.1"]',
    'not json',
  ])
    await assert.rejects(
      loadConfig({ ...env, BIFROST_BROWSER_ORIGINS: origins }, installation),
      /origin/i,
      origins,
    );
});

test('An audit file inside the workspace is refused before it is created', async (t) => {
  const { env, workspace, installation } = await fixture(t);
  const audit = path.join(workspace, 'audit.jsonl');
  await assert.rejects(loadConfig({ ...env, BIFROST_AUDIT_FILE: audit }, installation), /Audit/);
  await assert.rejects(fs.stat(audit));
});

test('An audit file outside the workspace is created owner-only', async (t) => {
  const { env, dir, installation } = await fixture(t);
  const audit = path.join(dir, 'audit.jsonl');
  const config = await loadConfig({ ...env, BIFROST_AUDIT_FILE: audit }, installation);
  assert.equal(config.auditFile, audit);
  assert.equal((await fs.stat(audit)).mode & 0o777, 0o600);
});
