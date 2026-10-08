import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../src/bridge.js';
import { Policy } from '../src/policy.js';
import { createServer } from '../src/server.js';
async function setup(t, mode = 'ask') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bifrost-policy-'));
  const bridge = await new Bridge({ workspace: dir, origins: ['https://fixture.invalid'] }).init();
  let url = 'https://fixture.invalid/a',
    clicks = 0;
  bridge.browser = { close: async () => {} };
  bridge.page = {
    url: () => url,
    title: async () => '',
    locator: () => ({
      click: async () => {
        clicks++;
      },
      innerText: async () => '',
    }),
  };
  const policy = new Policy({ mode });
  const server = createServer(bridge, policy);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    bridge,
    policy,
    client,
    setUrl: (value) => {
      url = value;
      bridge.documentVersion++;
    },
    clicks: () => clicks,
  };
}
test('Browser approval cannot transfer to another document', async (t) => {
  const { client, policy, setUrl, clicks } = await setup(t);
  const args = { selector: '#confirm' };
  const pending = JSON.parse(
    (await client.callTool({ name: 'browser_click', arguments: args })).content[0].text,
  );
  policy.approveLocal(pending.requestId);
  setUrl('https://fixture.invalid/b');
  const result = await client.callTool({
    name: 'browser_click',
    arguments: { ...args, approvalId: pending.requestId },
  });
  assert.equal(result.isError, true);
  assert.equal(clicks(), 0);
});
test('Queued Auto browser action cannot execute after reduce to Ask', async (t) => {
  const { client, bridge, clicks } = await setup(t, 'auto');
  let release;
  bridge.browserQueue = new Promise((r) => {
    release = r;
  });
  const result = client.callTool({ name: 'browser_click', arguments: { selector: '#confirm' } });
  while (bridge.queuedBrowser === 0) await new Promise((r) => setTimeout(r, 1));
  await client.callTool({ name: 'permissions_reduce', arguments: {} });
  release();
  assert.equal((await result).isError, true);
  assert.equal(clicks(), 0);
});
test('Browser queue admission is capped', async (t) => {
  const { bridge } = await setup(t, 'auto');
  let release;
  bridge.browserQueue = new Promise((r) => {
    release = r;
  });
  const pending = Array.from({ length: 4 }, () => bridge.browserAction('snapshot', {}));
  await assert.rejects(bridge.browserAction('snapshot', {}));
  release();
  await Promise.all(pending);
  assert.equal(bridge.queuedBrowser, 0);
});
test('Ask mode leaves read-only session health and receipts available', async (t) => {
  const { client, bridge } = await setup(t, 'ask');
  await bridge.invoke('fixture', async () => ({ output: 'private-content' }));
  const status = JSON.parse(
    (await client.callTool({ name: 'session_status', arguments: {} })).content[0].text,
  );
  assert.equal(status.mode, 'ask');
  const receipts = JSON.parse(
    (await client.callTool({ name: 'recent_receipts', arguments: { limit: 1 } })).content[0].text,
  );
  assert.equal(receipts.sessionId, status.sessionId);
  assert.equal(receipts.receipts.length, 1);
  assert.ok(!JSON.stringify(receipts).includes('private-content'));
});
