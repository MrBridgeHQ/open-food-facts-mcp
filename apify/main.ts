import { createActorHandler, createActorHttpServer, parseActorConfig } from './server.ts';

const config = parseActorConfig(process.env);
const actor = await createActorHandler({ userAgent: config.userAgent });
if (config.atHome && !config.standby) {
  // Normal batch Start is an offline protocol self-check; it makes zero OFF requests.
  process.stderr.write('MCP self-check: ' + actor.toolNames.length + ' tools; no OFF requests\n');
  await actor.close();
} else {
  const http = createActorHttpServer(actor, config);
  try {
    await new Promise<void>((resolve, reject) => {
      http.server.once('error', reject);
      http.server.listen(config.port, config.bindHost, () => {
        http.server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await actor.close();
    throw error;
  }
  process.stderr.write('MCP HTTP listening on ' + config.bindHost + ':' + config.port + '\n');
  let stopping = false;
  let finish!: () => void;
  const lifetime = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void http.shutdown().catch(error => {
      process.stderr.write((error instanceof Error ? error.message : 'Shutdown failed') + '\n');
      process.exitCode = 1;
    }).finally(finish);
  };
  const fatal = (error: Error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
    stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  http.server.once('error', fatal);
  try { await lifetime; }
  finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    http.server.off('error', fatal);
  }
}
