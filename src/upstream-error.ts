export type UpstreamDetails = {
  status: number;
  content_type_class: 'html' | 'json' | 'text' | 'other' | 'unknown';
  body_excerpt: string | null;
  body_truncated: boolean;
  body_read_error: boolean;
  excerpt_policy: 'allowlisted_error_phrases';
};

const BODY_LIMIT = 8192;
const BODY_DEADLINE_MS = 500;
// Return canonical closed-list phrases, never arbitrary upstream text. This
// deliberately omits unknown error text rather than guessing at secret formats.
const PHRASES = [
  'Page temporarily unavailable - Open Food Facts',
  'Service Temporarily Unavailable', 'Service Unavailable', 'Bad Gateway',
  'Gateway Timeout', 'Internal Server Error', 'upstream connect error',
  'no healthy upstream', 'Access denied', 'Too Many Requests',
  'nginx', 'cloudflare', 'varnish',
];

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  let abort = () => {};
  try {
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      abort = () => reject(new Error('Body deadline'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      reader.read().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function contentTypeClass(value: string | null): UpstreamDetails['content_type_class'] {
  // Only a fixed MIME category is returned; never return the header value.
  const mime = value?.slice(0, 128).split(';', 1)[0].trim().toLowerCase();
  if (!mime) return 'unknown';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/json' || mime === 'application/problem+json') return 'json';
  if (mime === 'text/plain') return 'text';
  return 'other';
}

/** Preserve a received HTTP status even if reading or cancelling its body fails. */
export async function captureUpstreamError(response: Response, signal: AbortSignal): Promise<UpstreamDetails> {
  const details: UpstreamDetails = {
    status: response.status, content_type_class: contentTypeClass(response.headers.get('content-type')),
    body_excerpt: null, body_truncated: false,
    body_read_error: false, excerpt_policy: 'allowlisted_error_phrases',
  };
  if (!response.body) return details;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, BODY_DEADLINE_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const bytes = new Uint8Array(BODY_LIMIT + 1);
  let length = 0, done = false, emptyChunks = 0;
  const deadline = Date.now() + BODY_DEADLINE_MS;
  try {
    reader = response.body.getReader();
    while (length < bytes.length) {
      // Bound zero-length synchronous streams as well as normal stalled I/O.
      if (Date.now() >= deadline || emptyChunks > 32) throw new Error('Body deadline');
      const next = await readChunk(reader, controller.signal);
      if (next.done) { done = true; break; }
      if (!next.value.byteLength) emptyChunks++;
      const kept = Math.min(next.value.byteLength, bytes.length - length);
      bytes.set(next.value.subarray(0, kept), length);
      length += kept;
    }
  } catch {
    details.body_read_error = true;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (reader) {
      if (!done) {
        try { void reader.cancel().catch(() => {}); } catch { /* status still survives */ }
      }
      try { reader.releaseLock(); } catch { /* pending read may retain the lock */ }
    }
  }
  details.body_truncated = !done || length > BODY_LIMIT;
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(length, BODY_LIMIT)));
  const phrases = PHRASES.filter(phrase => new RegExp('\\b' + phrase + '\\b', 'i').test(prefix));
  details.body_excerpt = phrases.length ? phrases.join(' | ').slice(0, 256) : null;
  return details;
}
