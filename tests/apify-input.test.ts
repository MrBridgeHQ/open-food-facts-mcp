import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActorUserAgent } from '../apify/input.ts';
import { createService } from '../src/service.ts';

const CLOUD = {
  APIFY_IS_AT_HOME: '1',
  ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'store_123',
  APIFY_TOKEN: 'private-token',
};
const INVALID_EMAIL = 'contactEmail is required and must be a valid email address';
const INPUT_UNAVAILABLE = 'Unable to read Actor input; enable input forwarding in your private Standby task';
const ua = (email: string) => 'open-food-facts-mcp/0.1.0 (' + email + ')';
const inputResponse = (contactEmail: unknown) =>
  new Response(JSON.stringify({ contactEmail }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

test('cloud reads only the fixed Apify INPUT record and constructs per-run UA', async () => {
  let calls = 0;
  const get: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input),
      'https://api.apify.com/v2/key-value-stores/store_123/records/INPUT');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-token');
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    assert.ok(init?.signal);
    return inputResponse('person@example.org');
  };
  const result = await resolveActorUserAgent({
    ...CLOUD,
    OFF_USER_AGENT: 'shared/0.1 (bridge@example.org)',
    OFF_CONTACT_EMAIL: 'ignored@example.org',
  }, get);
  assert.equal(result, ua('person@example.org'));
  assert.equal(calls, 1);
});

test('custom ACTOR_INPUT_KEY is encoded and local mode never reads KVS', async () => {
  const get: typeof fetch = async input => {
    assert.equal(String(input),
      'https://api.apify.com/v2/key-value-stores/store_123/records/my%20input');
    return inputResponse('other@example.org');
  };
  assert.equal(await resolveActorUserAgent({ ...CLOUD, ACTOR_INPUT_KEY: 'my input' }, get),
    ua('other@example.org'));
  let fetched = false;
  const forbidden: typeof fetch = async () => { fetched = true; throw new Error('unexpected fetch'); };
  assert.equal(await resolveActorUserAgent({ OFF_CONTACT_EMAIL: 'local@example.org',
    OFF_USER_AGENT: 'ignored/1 (bridge@example.org)' }, forbidden), ua('local@example.org'));
  assert.equal(fetched, false);
});

test('missing, malformed and unsafe emails fail without echoing their content', async () => {
  const bad = [undefined, '', 'plain-address', 'bad@example.org\r\nInjected: yes',
    'bad(user)@example.org', 'u'.repeat(161) + '@example.org', 'é@example.org'];
  for (const value of bad) {
    const privateError = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, INVALID_EMAIL);
      if (typeof value === 'string' && value.length > 0) assert.ok(!error.message.includes(value));
      return true;
    };
    await assert.rejects(resolveActorUserAgent({ OFF_CONTACT_EMAIL: value }), privateError);
    const get: typeof fetch = async () => inputResponse(value);
    await assert.rejects(resolveActorUserAgent(CLOUD, get), privateError);
  }
});

test('cloud has no shared-UA fallback on missing input or API failures', async () => {
  const stale = { ...CLOUD, OFF_USER_AGENT: 'shared/1 (bridge@example.org)' };
  for (const response of [new Response(null, { status: 404 }),
    new Response('{}', { status: 200 }), new Response('[]', { status: 200 })]) {
    await assert.rejects(resolveActorUserAgent(stale, async () => response),
      error => error instanceof Error && error.message === INVALID_EMAIL);
  }
  for (const response of [new Response(null, { status: 503 }),
    new Response('{', { status: 200 }),
    new Response('x'.repeat(16 * 1024 + 1), { status: 200 }),
    new Response('{}', { status: 200, headers: { 'Content-Length': String(16 * 1024 + 1) } })]) {
    await assert.rejects(resolveActorUserAgent(stale, async () => response),
      error => error instanceof Error && error.message === INPUT_UNAVAILABLE);
  }
  for (const key of ['.', '..']) {
    let called = false;
    await assert.rejects(resolveActorUserAgent({ ...CLOUD, ACTOR_INPUT_KEY: key },
      async () => { called = true; return inputResponse('x@example.org'); }),
      error => error instanceof Error && error.message === INPUT_UNAVAILABLE);
    assert.equal(called, false);
  }
  const refused: typeof fetch = async () => { throw new Error('private-token'); };
  await assert.rejects(resolveActorUserAgent(stale, refused), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, INPUT_UNAVAILABLE);
    return true;
  });
});

test('separate per-run services keep their UA and cached responses separate', async () => {
  const seen: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get('User-Agent') ?? '');
    return new Response(JSON.stringify({ status: 'success', product: {
      code: '1234', product_name: 'Fixture' } }));
  };
  const uaA = await resolveActorUserAgent(CLOUD,
    async () => inputResponse('a@example.org'));
  const uaB = await resolveActorUserAgent(CLOUD,
    async () => inputResponse('b@example.org'));
  const serviceA = createService({ userAgent: uaA, fetch: fakeFetch });
  const serviceB = createService({ userAgent: uaB, fetch: fakeFetch });
  const firstA = await serviceA.getProduct({ barcode: '1234' });
  const firstB = await serviceB.getProduct({ barcode: '1234' });
  const secondA = await serviceA.getProduct({ barcode: '1234' });
  assert.equal(firstA.cache_hit, false);
  assert.equal(firstB.cache_hit, false);
  assert.equal(secondA.cache_hit, true);
  assert.deepEqual(seen, [uaA, uaB]);
});
