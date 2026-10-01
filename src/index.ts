import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './server.ts';

const userAgent=process.env.OFF_USER_AGENT;
if (!userAgent) { process.stderr.write('OFF_USER_AGENT is required (app/version, contact email)\n'); process.exitCode=1; }
else {
  try { await createMcpServer({userAgent}).connect(new StdioServerTransport()); }
  catch(e) { process.stderr.write(`${e instanceof Error ? e.message : 'Startup error'}\n`); process.exitCode=1; }
}
