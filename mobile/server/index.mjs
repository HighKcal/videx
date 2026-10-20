import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configurationIssues, createVidexServer } from './server.mjs';

export async function startServer(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '8787';
  if (typeof host !== 'string' || !host.length || host.length > 253 || !/^[a-zA-Z0-9_.:-]+$/.test(host) || !/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw Error('Invalid bind configuration');
  const server = createVidexServer({ env });
  server.listen(Number(rawPort), host);
  await once(server, 'listening');
  const issues = configurationIssues(env);
  if (issues.length) console.error(`VIDEX configuration unavailable: ${issues.join(', ')}. Paid API disabled; health ready=false.`);
  const displayHost = host.includes(':') ? `[${host}]` : host;
  console.log(`VIDEX listening on http://${displayHost}:${server.address().port}`);
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const server = await startServer();
    const shutdown = () => {
      server.close();
      const timer = setTimeout(() => server.closeAllConnections(), 5000);
      timer.unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    server.on('error', () => { console.error('VIDEX server unavailable'); process.exitCode = 1; shutdown(); });
  } catch {
    console.error('VIDEX could not start; check HOST, PORT and public build configuration.');
    process.exitCode = 1;
  }
}
