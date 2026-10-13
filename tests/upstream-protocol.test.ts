import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/server.ts';
import { createService, ServiceError } from '../src/service.ts';

const userAgent = 'off-mcp/0.1.0 (fixture-private@example.org)';
const args = { category: 'en:chocolates', page_size: 1 };

test('MCP preserves the upstream status and safe excerpt without retrying or leaking the contact', async () => {
  let calls = 0;
  const server = createMcpServer({ userAgent, fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/api/v3.6/product/1234');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
    assert.equal(new Headers(init?.headers).get('user-agent'), userAgent);
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(`<html><h1>503 Service Unavailable</h1>${userAgent} Bearer private-token</html>`, { status: 503 });
  } });
  const client = new Client({ name: 'upstream-offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: 'get_product', arguments: { barcode: '1234' } });
    assert.equal(response.isError, true);
    const value = JSON.parse((response.content[0] as { text: string }).text);
    assert.deepEqual(response.structuredContent, value);
    assert.equal(value.error.code, 'UPSTREAM');
    assert.equal(value.error.message, 'Open Food Facts server error');
    assert.equal(value.error.retry_after_seconds, null);
    assert.equal(value.error.upstream.status, 503);
    assert.match(value.error.upstream.body_excerpt, /Service Unavailable/i);
    assert.equal(value.error.upstream.excerpt_policy, 'allowlisted_error_phrases');
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(response), /fixture-private|example\.org|private-token|off-mcp\/0\.1\.0/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('body timeout keeps a received 502 and UPSTREAM, and an explicit next call is not cached', async () => {
  let calls = 0;
  const service = createService({ userAgent, timeoutMs: 20, fetch: async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}); },
      cancel() { return new Promise(() => {}); },
    }), { status: 502 });
  } });
  const started = Date.now();
  const check = (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, 'UPSTREAM');
    assert.equal(error.upstream?.status, 502);
    assert.equal(error.upstream?.body_read_error, true);
    return true;
  };
  await assert.rejects(service.searchProducts(args), check);
  assert.equal(calls, 1);
  await assert.rejects(service.searchProducts(args), check);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1500);
});

test('429 keeps its cooldown and retry delay without adding a 5xx diagnostic', async () => {
  let calls = 0;
  const service = createService({ userAgent, fetch: async () => {
    calls++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
  } });
  for (let index = 0; index < 2; index++) {
    await assert.rejects(service.searchProducts(args), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.retry_after_seconds, 30);
      assert.equal(error.upstream, undefined);
      return true;
    });
  }
  assert.equal(calls, 1);
});
