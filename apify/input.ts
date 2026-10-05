import * as z from 'zod/v4';

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_EMAIL_LENGTH = 160;
const CONTACT_SCHEMA = z.email();
const INVALID_EMAIL = 'contactEmail is required and must be a valid email address';
const INPUT_UNAVAILABLE = 'Unable to read Actor input; enable input forwarding in your private Standby task';

function userAgentFromEmail(value: unknown): string {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f()]/u.test(value)) {
    throw new Error(INVALID_EMAIL);
  }
  const email = value.trim();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH ||
      !/^[\x21-\x7e]+$/u.test(email) || !CONTACT_SCHEMA.safeParse(email).success) {
    throw new Error(INVALID_EMAIL);
  }
  return 'open-food-facts-mcp/0.1.0 (' + email + ')';
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const header = response.headers.get('Content-Length');
  if (header !== null && /^\d+$/u.test(header) && Number(header) > MAX_INPUT_BYTES) {
    throw new Error(INPUT_UNAVAILABLE);
  }
  if (!response.body) throw new Error(INPUT_UNAVAILABLE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_INPUT_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error(INPUT_UNAVAILABLE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Resolves the contact of this run; never accepts a shared UA fallback on Apify. */
export async function resolveActorUserAgent(
  env: NodeJS.ProcessEnv,
  fetchOverride: typeof fetch = fetch,
): Promise<string> {
  const atHome = ['1', 'true'].includes((env.APIFY_IS_AT_HOME ?? '').toLowerCase());
  if (!atHome) return userAgentFromEmail(env.OFF_CONTACT_EMAIL);

  const storeId = env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID;
  const key = env.ACTOR_INPUT_KEY === undefined ? 'INPUT' : env.ACTOR_INPUT_KEY;
  const token = env.APIFY_TOKEN;
  if (!storeId || !token || !/^[A-Za-z0-9_-]{1,128}$/u.test(storeId) ||
      !key || key === '.' || key === '..' || key.length > 128 ||
      /[\x00-\x1f\x7f]/u.test(key) || /[\x00-\x1f\x7f]/u.test(token)) {
    throw new Error(INPUT_UNAVAILABLE);
  }
  const url = 'https://api.apify.com/v2/key-value-stores/' +
    encodeURIComponent(storeId) + '/records/' + encodeURIComponent(key);
  let response: Response;
  try {
    response = await fetchOverride(url, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch { throw new Error(INPUT_UNAVAILABLE); }
  if (response.status === 404) throw new Error(INVALID_EMAIL);
  if (!response.ok) throw new Error(INPUT_UNAVAILABLE);
  let input: unknown;
  try { input = await readLimitedJson(response); }
  catch { throw new Error(INPUT_UNAVAILABLE); }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.hasOwn(input, 'contactEmail')) {
    throw new Error(INVALID_EMAIL);
  }
  return userAgentFromEmail((input as Record<string, unknown>).contactEmail);
}
