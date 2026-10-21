import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createVidexServer } from './server.mjs';

async function fixture(t) {
  const root = await mkdtemp(fileURLToPath(new URL('./.static-test-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + '/dist/assets', { recursive: true });
  await writeFile(root + '/dist/index.html', '<!doctype html><title>fixture</title>');
  await writeFile(root + '/dist/assets/app-test.js', 'export const value = 1;');
  await writeFile(root + '/dist/assets/runtime.wasm', Buffer.from([0, 97, 115, 109]));
  await writeFile(root + '/dist/sw.js', '/* public static-only worker fixture */');
  await writeFile(root + '/dist/_headers', 'not executable config');
  await writeFile(root + '/outside.js', 'private fixture must not be served');
  await symlink(root + '/outside.js', root + '/dist/assets/link.js');
  await symlink(root, root + '/dist/linked');
  const server = createVidexServer({ env: {}, distDir: root + '/dist', fetcher: () => { throw Error('Never upstream'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { root, url: `http://127.0.0.1:${server.address().port}` };
}
function raw(url, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('same port serves built assets with live CSP, no-store worker and no API caching', async t => {
  const { url } = await fixture(t);
  const index = await fetch(url + '/');
  assert.equal(index.status, 200);
  assert.equal(await index.text(), '<!doctype html><title>fixture</title>');
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = index.headers.get('content-security-policy');
  for (const directive of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:", "media-src 'self' blob:", "connect-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.equal(csp.includes('api.openai.com'), false);
  assert.equal(csp.includes('wss:'), false);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(index.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  const script = await fetch(url + '/assets/app-test.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await script.text(), 'export const value = 1;');
  const wasm = await fetch(url + '/assets/runtime.wasm');
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  const worker = await fetch(url + '/sw.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('cache-control'), 'no-store');
  const head = await raw(url, '/assets/app-test.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal((await fetch(url + '/api/health')).headers.get('cache-control'), 'no-store');
});

test('static traversal, symlinks, hidden/config/source files and API fallbacks are denied', async t => {
  const { root, url } = await fixture(t);
  for (const path of ['/../outside.js', '/%2e%2e/outside.js', '/assets/../../outside.js', '/assets/link.js', '/linked/outside.js', '/assets\\..\\outside.js', '/%00.js', '/%ZZ', '//outside.js', '/_headers', '/.hidden', '/server/index.mjs', '/src/main.tsx', '/missing.js', '/api/nope', '/api/health?unexpected=1']) {
    const r = await raw(url, path);
    assert.ok([400, 403, 404].includes(r.status), `${path}: ${r.status}`);
    assert.ok(!r.text.includes('private fixture'));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(typeof JSON.parse(r.text).error, 'string');
  }
  assert.equal((await raw(url, '/', 'POST')).status, 405);
  await symlink(root + '/dist', root + '/dist-link');
  const other = createVidexServer({ env: {}, distDir: root + '/dist-link' });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolve => { other.close(resolve); other.closeAllConnections(); }));
  assert.equal((await fetch(`http://127.0.0.1:${other.address().port}/`)).status, 404);
});
