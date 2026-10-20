import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function boot(t, cwd, entry, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd, env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  let stdout = '', stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const listening = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/VIDEX listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.once('exit', () => reject(Error(`Startup failed: ${stderr}`)));
    child.once('error', reject);
  });
  return { url: await listening, output: () => stdout + stderr };
}

test('CLI starts from repository root and mobile, serves actual existing dist, and fails closed without secrets', { timeout: 5000 }, async t => {
  for (const [directory, entry] of [['../../', 'mobile/server/index.mjs'], ['../', 'server/index.mjs']]) {
    const { url, output } = await boot(t, fileURLToPath(new URL(directory, import.meta.url)), entry);
    const health = await fetch(url + '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ready: false, authRequired: true });
    const index = await fetch(url + '/');
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('<title>VIDEX</title>'));
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
    assert.equal((await fetch(url + asset)).status, 200);
    const response = await fetch(url + '/api/speech', { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    assert.equal(response.status, 503);
    for (const name of ['OPENAI_API_KEY', 'VIDEX_ACCESS_TOKEN', 'VIDEX_ALLOWED_ORIGINS']) assert.ok(output().includes(name));
  }
});

test('CLI rejects malformed bind settings with generic diagnostics and no secret values', async () => {
  for (const overrides of [{ PORT: 'bad' }, { PORT: '65536' }, { HOST: 'bad/host' }]) {
    const child = spawn(process.execPath, ['mobile/server/index.mjs'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { PATH: process.env.PATH, OPENAI_API_KEY: 'synthetic-never-log-this', ...overrides },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.ok(output.includes('VIDEX could not start'));
    assert.ok(!output.includes('synthetic-never-log-this'));
  }
});
