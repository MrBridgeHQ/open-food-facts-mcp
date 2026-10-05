import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createActorHandler, createActorHttpServer, parseActorConfig } from '../apify/server.ts';

const ua = 'off-actor-test/0.1.0 (test@example.org)';
const codeA = '3017620422003';
const codeB = '3017620425035';
function product(code: string) {
  return { status: 'success', product: {
    code, product_name: 'Fixture ' + code, brands: 'Nutella',
    nutrition: { aggregated_set: { per: '100g', preparation: 'as_sold',
      nutrients: { proteins: { value: 6.3, unit: 'g' }, sugars: { value: 56.3, unit: 'g' } } },
      input_sets: [] },
  } };
}
function fixtureFetch(counter: { calls: number }, gate?: Promise<void>): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    if (url.pathname.includes('/api/v3.6/product/')) {
      counter.calls++;
      if (gate) await gate;
      const code = url.pathname.split('/').at(-1)!;
      return code === '7777' ? new Response(null, { status: 404 }) :
        new Response(JSON.stringify(product(code)));
    }
    if (url.pathname === '/api/v2/search') {
      return new Response(JSON.stringify({ products: [{ code: codeA, product_name: 'Fixture', brands: 'Nutella' }], count: 1 }));
    }
    if (url.pathname === '/search') {
      return new Response(JSON.stringify({ hits: [{ code: codeA, product_name: 'Fixture', brands: ['Nutella'] }], count: 1, is_count_exact: true }));
    }
    if (url.pathname === '/autocomplete') {
      return new Response(JSON.stringify({ options: [{ id: 'en:chocolate', text: 'Chocolate', taxonomy_name: 'category' }] }));
    }
    throw new Error('Unexpected fixture URL: ' + url);
  };
}
type Actor = Awaited<ReturnType<typeof createActorHandler>>;
async function connect(actor: Actor) {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (input, init) => actor.fetch(new Request(input, init)),
  });
  const client = new Client({ name: 'actor-test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
async function localRequest(port: number, path: string, options: {
  method?: string; host?: string; origin?: string; body?: string; chunks?: string[];
  accept?: string;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { Host: options.host ?? 'allowed.test',
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.accept ? { Accept: options.accept } : {}) },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end(options.body);
  });
}

test('two clients share in-flight cache and reconnect to one backend', async () => {
  const count = { calls: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch(count, gate) });
  const a = await connect(actor), b = await connect(actor);
  try {
    assert.deepEqual((await a.listTools()).tools.map(tool => tool.name).sort(),
      ['compare_products', 'get_product', 'get_taxonomy', 'search_products', 'search_text']);
    const one = a.callTool({ name: 'get_product', arguments: { barcode: codeA, language: 'en' } });
    const two = b.callTool({ name: 'get_product', arguments: { barcode: codeA, language: 'en' } });
    release();
    const results = await Promise.all([one, two]);
    assert.equal(count.calls, 1);
    assert.ok(results.every(result => result.isError !== true));
    await b.close();
    const reconnected = await connect(actor);
    try {
      const hit = await reconnected.callTool({ name: 'get_product', arguments: { barcode: codeA, language: 'en' } });
      assert.equal((hit.structuredContent as { cache_hit?: boolean } | undefined)?.cache_hit, true);
      assert.equal(count.calls, 1);
    } finally { await reconnected.close(); }
  } finally { await a.close(); await actor.close(); }
});

test('all five tools relay structured data and tool errors', async () => {
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch({ calls: 0 }) });
  const client = await connect(actor);
  try {
    for (const [name, args] of [
      ['get_product', { barcode: codeA }],
      ['search_products', { brand: 'nutella', page_size: 2 }],
      ['search_text', { query: 'nutella', page_size: 2 }],
      ['get_taxonomy', { query: 'choc', taxonomy: 'categories', limit: 2 }],
      ['compare_products', { barcodes: [codeA, codeB] }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      const block = result.content.find(item => item.type === 'text');
      assert.ok(block && block.type === 'text');
      assert.deepEqual(JSON.parse(block.text), result.structuredContent);
    }
    const missing = await client.callTool({ name: 'get_product', arguments: { barcode: '7777' } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as { error?: { code?: string } } | undefined)?.error?.code, 'NOT_FOUND');
  } finally { await client.close(); await actor.close(); }
});

test('quota of 15 products is shared across HTTP clients', async () => {
  const count = { calls: 0 };
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch(count) });
  const a = await connect(actor), b = await connect(actor);
  try {
    for (let i = 0; i < 15; i++) {
      const result = await (i % 2 ? a : b).callTool({
        name: 'get_product', arguments: { barcode: String(1000 + i) },
      });
      assert.notEqual(result.isError, true);
    }
    const result = await b.callTool({ name: 'get_product', arguments: { barcode: '2000' } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code, 'LOCAL_RATE_LIMIT');
    assert.equal(count.calls, 15);
  } finally { await Promise.allSettled([a.close(), b.close()]); await actor.close(); }
});

test('readiness, guards, malformed JSON, chunked size and legacy SSE via Node HTTP', async () => {
  const count = { calls: 0 };
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch(count) });
  const http = createActorHttpServer(actor, {
    allowedHosts: ['allowed.test'], allowedOrigins: ['https://allowed.test'],
  });
  await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve));
  const address = http.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  try {
    const ready = await localRequest(port, '/', { host: 'probe.internal' });
    assert.equal(ready.status, 200);
    assert.equal(JSON.parse(ready.body).tools, 5);
    assert.equal(count.calls, 0);
    assert.equal((await localRequest(port, '/mcp', { host: 'evil.test', method: 'POST', body: '{}' })).status, 400);
    assert.equal((await localRequest(port, '/mcp', { origin: 'null', method: 'POST', body: '{}' })).status, 403);
    assert.equal((await localRequest(port, '/mcp', { origin: 'http://allowed.test', method: 'POST', body: '{}' })).status, 403);
    const malformed = await localRequest(port, '/mcp', { method: 'POST', body: '{',
      accept: 'application/json, text/event-stream' });
    assert.ok(malformed.status >= 400 || JSON.parse(malformed.body).error);
    const large = await localRequest(port, '/mcp', {
      method: 'POST', chunks: ['x'.repeat(40_000), 'x'.repeat(30_000)],
    });
    assert.equal(large.status, 413);
    const initialized = await localRequest(port, '/mcp', {
      method: 'POST', accept: 'application/json, text/event-stream',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {},
          clientInfo: { name: 'legacy-test', version: '1.0.0' } } }),
    });
    assert.equal(initialized.status, 200);
    const dataLine = initialized.body.split(/\r?\n/).find(line => line.startsWith('data:'));
    const payload = dataLine ? dataLine.slice(5).trim() : initialized.body;
    assert.equal(JSON.parse(payload).result.protocolVersion, '2025-11-25');
    assert.equal(count.calls, 0);
  } finally { await http.shutdown(); }
});

test('shutdown waits for a received slow request, then aborts and closes sockets', async () => {
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch({ calls: 0 }) });
  const http = createActorHttpServer(actor, {
    allowedHosts: ['allowed.test'], allowedOrigins: [], shutdownGraceMs: 50,
  });
  await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve));
  const address = http.server.address();
  assert.ok(address && typeof address !== 'string');
  const received = new Promise<void>(resolve => http.server.once('request', () => resolve()));
  const slow = httpRequest({
    hostname: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST',
    headers: { Host: 'allowed.test', 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
  });
  slow.on('error', () => {});
  slow.write('{"jsonrpc":');
  await received;
  const start = Date.now();
  await http.shutdown();
  assert.ok(Date.now() - start < 2_000);
  slow.destroy();
});

test('shutdown closes partial-header sockets and also works before listen', async () => {
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch({ calls: 0 }) });
  const http = createActorHttpServer(actor, { allowedHosts: ['allowed.test'], allowedOrigins: [] });
  await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve));
  const address = http.server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = netConnect(address.port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>(resolve => socket.once('connect', () => resolve()));
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.write('POST /mcp HTTP/1.1\r\nHost: allowed.test\r\n');
  const start = Date.now();
  await http.shutdown();
  await closed;
  assert.ok(Date.now() - start < 2_000);
  const secondActor = await createActorHandler({ userAgent: ua, fetch: fixtureFetch({ calls: 0 }) });
  const second = createActorHttpServer(secondActor, { allowedHosts: [], allowedOrigins: [] });
  await second.shutdown();
  await second.shutdown();
});

test('config separates local, Standby and batch modes', () => {
  const local = parseActorConfig({ OFF_USER_AGENT: ua });
  assert.equal(local.bindHost, '127.0.0.1');
  assert.equal(local.port, 4321);
  const standby = parseActorConfig({ OFF_USER_AGENT: ua, APIFY_IS_AT_HOME: '1',
    APIFY_META_ORIGIN: 'STANDBY', ACTOR_WEB_SERVER_PORT: '4321',
    ACTOR_STANDBY_URL: 'https://example.apify.actor/' });
  assert.ok(standby.allowedHosts.includes('example.apify.actor'));
  assert.ok(standby.allowedOrigins.includes('https://example.apify.actor'));
  assert.ok(!standby.allowedOrigins.includes('http://example.apify.actor'));
  const batch = parseActorConfig({ OFF_USER_AGENT: ua, APIFY_IS_AT_HOME: '1', APIFY_META_ORIGIN: 'ACTOR' });
  assert.equal(batch.standby, false);
});
