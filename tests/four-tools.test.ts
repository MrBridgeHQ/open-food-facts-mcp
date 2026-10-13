import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/server.ts';
import { createActorHandler } from '../apify/server.ts';

const expected = ['compare_products', 'get_product', 'get_taxonomy', 'search_text'];
const removedCall = { name: 'search_products', arguments: { category: 'en:chocolates', page_size: 1 } };

async function assertUnavailable(client: Client) {
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), expected);
  // A raw request bypasses any client-side discovery check.
  await assert.rejects(client.request({ method: 'tools/call', params: removedCall }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /search_products/);
      assert.match(error.message, /not found|unknown|not registered/i);
      return true;
    });
}

test('four-tool backend rejects a removed tool before any upstream fetch', async () => {
  let calls = 0;
  const server = createMcpServer({ userAgent: 'off-test/0.6.0 (fixture@example.org)', fetch: async () => {
    calls++;
    throw new Error('No upstream request is permitted');
  } });
  const client = new Client({ name: 'four-tool-backend-test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    await assertUnavailable(client);
    assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});

test('Actor HTTP bridge exposes four tools and rejects removed calls without fetching', async () => {
  let calls = 0;
  const actor = await createActorHandler({ userAgent: 'off-test/0.6.0 (fixture@example.org)', fetch: async () => {
    calls++;
    throw new Error('No upstream request is permitted');
  } });
  const client = new Client({ name: 'four-tool-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (input, init) => actor.fetch(new Request(input, init)),
  });
  try {
    await client.connect(transport);
    assert.deepEqual([...actor.toolNames].sort(), expected);
    await assertUnavailable(client);
    assert.equal(calls, 0);
  } finally { await client.close(); await actor.close(); }
});
