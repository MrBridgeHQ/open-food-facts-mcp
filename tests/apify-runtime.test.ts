import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createActorHandler, createActorHttpServer } from '../apify/server.ts';

const ua = 'off-actor-runtime-test/0.1.0 (test@example.org)';
const barcodeA = '3017620422003';
const barcodeB = '3017620425035';
const entry = fileURLToPath(new URL('../apify/main.ts', import.meta.url));
const denyFetchHook = 'data:text/javascript,' + encodeURIComponent(
  'globalThis.fetch=()=>{process.stderr.write("UNEXPECTED_FETCH\\n");throw new Error("unexpected network fetch")}'
);

const mockInputHook = 'data:text/javascript,' + encodeURIComponent(
  'globalThis.fetch=async(input,init)=>{' +
  'if(String(input)==="https://api.apify.com/v2/key-value-stores/store_123/records/INPUT"&&' +
  'new Headers(init?.headers).get("Authorization")==="Bearer test-token")' +
  'return new Response(JSON.stringify({contactEmail:"run-owner@example.org"}));' +
  'process.stderr.write("UNEXPECTED_FETCH\\n");throw new Error("unexpected fetch")' +
  '}'
);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function product(code: string) {
  return { status: 'success', product: {
    code, product_name: 'Fixture ' + code, brands: 'Nutella',
    nutrition: { aggregated_set: { per: '100g', preparation: 'as_sold',
      nutrients: { proteins: { value: 6.3, unit: 'g' }, sugars: { value: 56.3, unit: 'g' } } },
      input_sets: [] },
  } };
}
function fixtures(seen: Array<{ url: string; authorization: string | null; cookie: string | null }>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.toString(), authorization: headers.get('authorization'), cookie: headers.get('cookie') });
    if (url.pathname.includes('/api/v3.6/product/')) {
      return new Response(JSON.stringify(product(url.pathname.split('/').at(-1)!)));
    }
    if (url.pathname === '/api/v2/search') {
      return new Response(JSON.stringify({ products: [{ code: barcodeA, product_name: 'Fixture', brands: 'Nutella' }], count: 1 }));
    }
    if (url.pathname === '/search') {
      return new Response(JSON.stringify({ hits: [{ code: barcodeA, product_name: 'Fixture', brands: ['Nutella'] }], count: 1, is_count_exact: true }));
    }
    if (url.pathname === '/autocomplete') {
      return new Response(JSON.stringify({ options: [{ id: 'en:chocolate', text: 'Chocolate', taxonomy_name: 'category' }] }));
    }
    throw new Error('Unexpected fixture URL ' + url);
  };
}
async function start(bearerToken?: string) {
  const port = await freePort();
  const seen: Array<{ url: string; authorization: string | null; cookie: string | null }> = [];
  const actor = await createActorHandler({ userAgent: ua, fetch: fixtures(seen) });
  const http = createActorHttpServer(actor, {
    allowedHosts: ['127.0.0.1:' + port],
    allowedOrigins: ['http://127.0.0.1:' + port],
    bearerToken,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.server.once('error', reject);
      http.server.listen(port, '127.0.0.1', () => { http.server.off('error', reject); resolve(); });
    });
  } catch (error) { await actor.close(); throw error; }
  return { actor, http, seen, url: new URL('http://127.0.0.1:' + port + '/mcp') };
}
async function clientFor(url: URL, authorization?: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    ...(authorization ? { requestInit: { headers: { Authorization: authorization, Cookie: 'local-test=1' } } } : {}),
  });
  const client = new Client({ name: 'runtime-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('SDK client reaches all five tools and input errors over a real local HTTP socket', async () => {
  const runtime = await start();
  const client = await clientFor(runtime.url);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
      ['compare_products', 'get_product', 'get_taxonomy', 'search_products', 'search_text']);
    const calls = [
      ['get_product', { barcode: barcodeA }],
      ['search_products', { brand: 'nutella', page_size: 2 }],
      ['search_text', { query: 'nutella', page_size: 2 }],
      ['get_taxonomy', { query: 'choc', taxonomy: 'categories', limit: 2 }],
      ['compare_products', { barcodes: [barcodeA, barcodeB] }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      const text = result.content.find(block => block.type === 'text');
      assert.ok(text && text.type === 'text');
      assert.deepEqual(JSON.parse(text.text), result.structuredContent);
    }
    assert.ok(runtime.seen.length >= 5);
    const before = runtime.seen.length;
    const invalid = await client.callTool({ name: 'get_product', arguments: { barcode: 'bad' } });
    assert.equal(invalid.isError, true);
    assert.equal(runtime.seen.length, before);
  } finally { await client.close(); await runtime.http.shutdown(); }
});

test('bearer guard rejects absent/wrong values and does not relay auth or cookies upstream', async () => {
  const runtime = await start('runtime-secret');
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'auth-test', version: '1.0.0' } } });
  const post = (authorization?: string) => fetch(runtime.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(authorization ? { Authorization: authorization } : {}) },
    body: initialize,
  });
  try {
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer runtime-secret']) {
      const response = await post(authorization);
      assert.equal(response.status, authorization === 'Bearer runtime-secret' ? 200 : 401);
      await response.text();
    }
    assert.equal(runtime.seen.length, 0);
    const client = await clientFor(runtime.url, 'Bearer runtime-secret');
    try {
      const result = await client.callTool({ name: 'get_product', arguments: { barcode: barcodeA } });
      assert.notEqual(result.isError, true);
    } finally { await client.close(); }
    assert.ok(runtime.seen.length > 0);
    assert.ok(runtime.seen.every(item => item.authorization === null && item.cookie === null));
  } finally { await runtime.http.shutdown(); }
});

test('GET and subscriptions/listen finish with an error rather than an open stream', async () => {
  const runtime = await start();
  try {
    const get = await fetch(runtime.url, {
      method: 'GET', headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(2_000),
    });
    assert.ok(get.status >= 400 && get.status < 500);
    await get.text();
    const listen = await fetch(runtime.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {} }),
      signal: AbortSignal.timeout(2_000),
    });
    const text = await listen.text();
    assert.ok(listen.status >= 400 || text.includes('error'));
    assert.equal(runtime.seen.length, 0);
  } finally { await runtime.http.shutdown(); }
});

test('batch main validates mocked Actor input and exits without OFF requests', () => {
  const child = spawnSync(process.execPath,
    ['--experimental-strip-types', '--import', mockInputHook, entry],
    { encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, OFF_USER_AGENT: ua,
        APIFY_IS_AT_HOME: '1', APIFY_META_ORIGIN: 'ACTOR',
        ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store_123', APIFY_TOKEN: 'test-token' } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /MCP self-check: 5 tools/);
  assert.doesNotMatch(child.stderr, /UNEXPECTED_FETCH/);
});

for (const mode of ['LOCAL', 'STANDBY'] as const) {
  test(mode + ' main answers readiness and exits cleanly on SIGTERM without OFF requests', async () => {
    const port = await freePort();
    const child = spawn(process.execPath,
      ['--experimental-strip-types', '--import', mode === 'STANDBY' ? mockInputHook : denyFetchHook, entry],
      { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OFF_USER_AGENT: ua,
          APIFY_IS_AT_HOME: mode === 'STANDBY' ? '1' : '0', APIFY_META_ORIGIN: mode,
          OFF_CONTACT_EMAIL: mode === 'LOCAL' ? 'local@example.org' : undefined,
          ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store_123', APIFY_TOKEN: 'test-token',
          ACTOR_WEB_SERVER_PORT: String(port), ACTOR_STANDBY_URL: 'http://127.0.0.1:' + port } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal })));
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const timeout = (message: string, ms = 5_000) => new Promise<never>((_, reject) => {
      timers.push(setTimeout(() => reject(new Error(message + ': ' + stderr)), ms));
    });
    try {
      await Promise.race([
        new Promise<void>(resolve => {
          const onData = () => {
            if (stderr.includes('MCP HTTP listening')) {
              child.stderr.off('data', onData);
              resolve();
            }
          };
          child.stderr.on('data', onData);
          onData();
        }),
        exited.then(() => { throw new Error('child exited before listening: ' + stderr); }),
        timeout('child startup timeout'),
      ]);
      for (const timer of timers) clearTimeout(timer);
      assert.ok(stderr.includes('MCP HTTP listening on ' + (mode === 'STANDBY' ? '0.0.0.0' : '127.0.0.1')));
      const response = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { tools: number }).tools, 5);
      child.kill('SIGTERM');
      const result = await Promise.race([exited, timeout('SIGTERM timeout')]);
      assert.equal(result.code, 0, stderr);
      assert.equal(result.signal, null);
      assert.doesNotMatch(stderr, /UNEXPECTED_FETCH/);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1_000); })]);
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
  });
}
