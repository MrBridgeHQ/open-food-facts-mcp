import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHandler, fromJsonSchema, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/server.ts';
import type { Config } from '../src/service.ts';

const TOOL_NAMES = ['get_product', 'search_products', 'search_text', 'get_taxonomy', 'compare_products'];
const MAX_BODY = 64 * 1024;
const MAX_ACTIVE = 16;
const REQUEST_TIMEOUT = 30_000;

export async function createActorHandler(config: Config) {
  const backend = createMcpServer(config);
  const client = new Client({ name: 'off-actor-bridge', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await backend.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    if (tools.length !== TOOL_NAMES.length ||
        !TOOL_NAMES.every(name => tools.some(tool => tool.name === name))) {
      throw new Error('Unexpected backend tool contract');
    }
    const frontend = createMcpHandler(() => {
      const server = new McpServer({ name: 'open-food-facts-mcp', version: '0.1.0' });
      for (const tool of tools) {
        server.registerTool(tool.name, {
          title: tool.title,
          description: tool.description,
          annotations: tool.annotations,
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]),
          ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]) } : {}),
        }, args => client.callTool({ name: tool.name, arguments: args }));
      }
      return server;
    }, { legacy: 'stateless', responseMode: 'json', maxSubscriptions: 0 });
    let closing: Promise<void> | undefined;
    return {
      toolNames: tools.map(tool => tool.name),
      fetch: (request: Request) => frontend.fetch(request),
      close() {
        closing ??= (async () => {
          const errors: unknown[] = [];
          try { await frontend.close(); } catch (error) { errors.push(error); }
          const results = await Promise.allSettled([client.close(), backend.close()]);
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
          if (errors.length) throw new AggregateError(errors, 'MCP shutdown failed');
        })();
        return closing;
      },
    };
  } catch (error) {
    await Promise.allSettled([client.close(), backend.close()]);
    throw error;
  }
}

type ActorHandler = Awaited<ReturnType<typeof createActorHandler>>;
export interface RuntimeConfig {
  userAgent: string;
  atHome: boolean;
  standby: boolean;
  port: number;
  bindHost: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  bearerToken?: string;
}
export function parseActorConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  if (!env.OFF_USER_AGENT) throw new Error('OFF_USER_AGENT is required');
  const atHome = ['1', 'true'].includes((env.APIFY_IS_AT_HOME ?? '').toLowerCase());
  const standby = env.APIFY_META_ORIGIN === 'STANDBY';
  if (atHome && standby && !env.ACTOR_WEB_SERVER_PORT) {
    throw new Error('ACTOR_WEB_SERVER_PORT is required in Standby');
  }
  const port = Number(env.ACTOR_WEB_SERVER_PORT ?? '4321');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid ACTOR_WEB_SERVER_PORT');
  }
  const allowedHosts = new Set(['localhost:' + port, '127.0.0.1:' + port]);
  const allowedOrigins = new Set(['http://localhost:' + port, 'http://127.0.0.1:' + port]);
  let configuredUrl = false;
  for (const key of ['ACTOR_STANDBY_URL', 'ACTOR_WEB_SERVER_URL'] as const) {
    const value = env[key];
    if (!value) continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid ' + key + ' protocol');
    allowedHosts.add(url.host.toLowerCase());
    allowedOrigins.add(url.origin);
    configuredUrl = true;
  }
  if (atHome && standby && !configuredUrl) {
    throw new Error('Standby needs ACTOR_STANDBY_URL or ACTOR_WEB_SERVER_URL');
  }
  return {
    userAgent: env.OFF_USER_AGENT, atHome, standby, port,
    bindHost: atHome ? '0.0.0.0' : '127.0.0.1',
    allowedHosts: [...allowedHosts], allowedOrigins: [...allowedOrigins],
    bearerToken: env.OFF_LOCAL_BEARER_TOKEN || undefined,
  };
}
export interface HttpOptions {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  bearerToken?: string;
  shutdownGraceMs?: number;
}
export function createActorHttpServer(actor: ActorHandler, options: HttpOptions) {
  const hosts = new Set(options.allowedHosts.map(value => value.toLowerCase()));
  const origins = new Set(options.allowedOrigins);
  const controllers = new Set<AbortController>();
  const idleWaiters: Array<() => void> = [];
  const grace = options.shutdownGraceMs ?? 10_000;
  if (!Number.isFinite(grace) || grace < 0) throw new Error('Invalid shutdownGraceMs');
  let closing = false;
  let active = 0;
  const server = createServer((req, res) => { void route(req, res); });
  server.headersTimeout = 10_000;
  server.requestTimeout = REQUEST_TIMEOUT;
  server.keepAliveTimeout = 5_000;
  function finish(controller: AbortController) {
    controllers.delete(controller);
    active--;
    if (active === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    if (closing) return json(res, 503, { error: 'shutting_down' }, { 'Retry-After': '1' });
    const path = req.url?.split('?', 1)[0];
    if (req.method === 'GET' && path === '/') {
      return json(res, 200, { status: 'ok', read_only: true, tools: actor.toolNames.length });
    }
    if (path !== '/mcp' || !req.url?.startsWith('/')) return json(res, 404, { error: 'not_found' });
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (!validHost(req.headers.host, hosts)) return json(res, 400, { error: 'invalid_host' });
    if (!validOrigin(req.headers.origin, origins)) return json(res, 403, { error: 'invalid_origin' });
    if (options.bearerToken && !validBearer(req.headers.authorization, options.bearerToken)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (active >= MAX_ACTIVE) return json(res, 503, { error: 'busy' }, { 'Retry-After': '1' });
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
      res.shouldKeepAlive = false;
      return json(res, 413, { error: 'request_too_large' });
    }
    if (req.method !== 'POST' && (Number(length ?? 0) > 0 || req.headers['transfer-encoding'])) {
      return json(res, 400, { error: 'unexpected_body' });
    }
    const controller = new AbortController();
    controllers.add(controller);
    active++;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const body = req.method === 'POST' ? await readBody(req, MAX_BODY, controller.signal) : undefined;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined ||
            ['host', 'content-length', 'transfer-encoding', 'connection',
             'authorization', 'cookie', 'proxy-authorization'].includes(name)) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const request = new Request('http://' + req.headers.host + req.url, {
        method: req.method, headers,
        body: body === undefined ? undefined : new Uint8Array(body),
        signal: controller.signal,
      });
      const response = await untilAbort(actor.fetch(request), controller.signal);
      if (res.destroyed) return;
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (!['connection', 'transfer-encoding', 'content-length'].includes(name.toLowerCase())) {
          res.setHeader(name, value);
        }
      });
      // maxSubscriptions=0 rejects unbounded listens; finite SDK SSE remains intact.
      const output = await untilAbort(response.arrayBuffer(), controller.signal);
      if (!res.destroyed) res.end(Buffer.from(output));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof RequestTooLarge) {
        res.shouldKeepAlive = false;
        return json(res, 413, { error: 'request_too_large' });
      }
      if (controller.signal.aborted) {
        res.shouldKeepAlive = false;
        return json(res, 504, { error: 'request_timeout' });
      }
      return json(res, 500, { error: 'internal_error' });
    } finally {
      clearTimeout(timer);
      finish(controller);
    }
  }
  let shutdownPromise: Promise<void> | undefined;
  return {
    server,
    shutdown() {
      shutdownPromise ??= (async () => {
        closing = true;
        let serverClosed: Promise<void> = Promise.resolve();
        if (server.listening) {
          serverClosed = new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections();
          });
        }
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (active > 0) {
            await Promise.race([
              new Promise<void>(resolve => idleWaiters.push(resolve)),
              new Promise<void>(resolve => { graceTimer = setTimeout(resolve, grace); }),
            ]);
          }
          if (active > 0) {
            for (const controller of controllers) controller.abort();
          }
          // Also closes sockets with incomplete headers and no request event.
          server.closeAllConnections();
        } finally {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
        }
        const results = await Promise.allSettled([serverClosed, actor.close()]);
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'HTTP shutdown failed');
      })();
      return shutdownPromise;
    },
  };
}
class RequestTooLarge extends Error {}
function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      req.off('aborted', onAborted); signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true; cleanup(); reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { req.pause(); fail(new RequestTooLarge()); }
      else chunks.push(chunk);
    };
    const onEnd = () => {
      if (done) return;
      done = true; cleanup(); resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error('request_aborted'));
    const onAbort = () => fail(new Error('request_timeout'));
    if (signal.aborted) return onAbort();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
    req.once('aborted', onAborted); signal.addEventListener('abort', onAbort, { once: true });
  });
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('request_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}
function validHost(host: string | undefined, allowed: ReadonlySet<string>) {
  return typeof host === 'string' && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && allowed.has(host.toLowerCase());
}
function validOrigin(origin: string | undefined, allowed: ReadonlySet<string>) {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try { return new URL(origin).origin === origin && allowed.has(origin); }
  catch { return false; }
}
function validBearer(header: string | undefined, expected: string) {
  if (!header?.startsWith('Bearer ') || header.length > 512) return false;
  return timingSafeEqual(
    createHash('sha256').update(header.slice(7)).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(value));
}
