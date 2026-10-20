import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createVidexServer } from './server.mjs';
import { JPEG } from './jpeg-fixture.mjs';

// Synthetic credentials and an injected provider; no process.env or paid upstream.
const DEMO_ENV = {
  VIDEX_DEMO_MODE: 'true',
  OPENAI_API_KEY: 'synthetic-demo-provider-credential',
  VIDEX_ALLOWED_ORIGINS: 'https://videx.example',
};
async function start(t, options = {}) {
  const server = createVidexServer({ env: DEMO_ENV, fetcher: () => { throw Error('Unexpected upstream'); }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function anonymousPost(url, path, body, headers = {}) {
  return fetch(url + path, {
    method: 'POST', headers: Object.fromEntries(Object.entries({ origin: 'https://videx.example', 'content-type': 'application/json', ...headers }).filter(([, value]) => value !== undefined)),
    body: JSON.stringify(body),
  });
}

test('explicit demo serves anonymous vision and speech without any access token', async t => {
  const calls = [];
  const url = await start(t, { fetcher: async (endpoint, options) => {
    calls.push({ endpoint, options });
    return endpoint.endsWith('/responses')
      ? Response.json({ output: [{ content: [{ type: 'output_text', text: '데모 인식' }] }] })
      : new Response('synthetic-audio', { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const health = await fetch(url + '/api/health');
  assert.deepEqual(await health.json(), { ready: true, authRequired: false });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const vision = await anonymousPost(url, '/api/vision', { image: JPEG, kind: 'ocr' });
  assert.equal(vision.status, 200);
  assert.deepEqual(await vision.json(), { text: '데모 인식' });
  const speech = await anonymousPost(url, '/api/speech', { text: '안내' });
  assert.equal(speech.status, 200);
  assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await speech.text(), 'synthetic-audio');
  for (const response of [vision, speech]) assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 2);
  for (const { options } of calls) assert.equal(options.headers.authorization, `Bearer ${DEMO_ENV.OPENAI_API_KEY}`);
});

test('demo still rejects missing, null and non-exact Origin without provider calls', async t => {
  let calls = 0;
  const url = await start(t, { fetcher: () => { calls++; throw Error('Must not reach provider'); } });
  for (const origin of [undefined, '', 'null', 'https://other.example', 'https://videx.example.evil', 'https://videx.example/', 'http://videx.example']) {
    for (const [path, body] of [['/api/vision', { image: JPEG, kind: 'ocr' }], ['/api/speech', { text: 'hello' }]]) {
      const response = await anonymousPost(url, path, body, { origin });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Forbidden' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal(calls, 0);
});

test('demo requires provider key and allowed origins but ignores unused access token configuration', async t => {
  let calls = 0;
  for (const invalid of [{ OPENAI_API_KEY: undefined }, { OPENAI_API_KEY: '' }, { VIDEX_ALLOWED_ORIGINS: undefined }, { VIDEX_ALLOWED_ORIGINS: '*' }]) {
    const url = await start(t, { env: { ...DEMO_ENV, ...invalid }, fetcher: () => { calls++; throw Error(); } });
    assert.deepEqual(await (await fetch(url + '/api/health')).json(), { ready: false, authRequired: false });
    const response = await anonymousPost(url, '/api/speech', { text: 'hello' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Service unavailable' });
  }
  assert.equal(calls, 0);
  const url = await start(t, { env: { ...DEMO_ENV, VIDEX_ACCESS_TOKEN: 'short-unused-token' }, fetcher: async () => new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }) });
  assert.deepEqual(await (await fetch(url + '/api/health')).json(), { ready: true, authRequired: false });
  assert.equal((await anonymousPost(url, '/api/speech', { text: 'hello' })).status, 200);
});

test('default and every non-exact demo flag retain bearer auth and token configuration checks', async t => {
  let calls = 0;
  for (const flag of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', true, 1, null]) {
    const env = { ...DEMO_ENV, VIDEX_DEMO_MODE: flag, VIDEX_ACCESS_TOKEN: 'synthetic-default-access-token-over-32-chars' };
    const url = await start(t, { env, fetcher: () => { calls++; throw Error('Unauthenticated call'); } });
    assert.deepEqual(await (await fetch(url + '/api/health')).json(), { ready: true, authRequired: true });
    for (const headers of [{}, { 'x-videx-demo-mode': 'true' }]) {
      const response = await anonymousPost(url, '/api/speech', { text: 'hello' }, headers);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
    const noTokenUrl = await start(t, { env: { ...env, VIDEX_ACCESS_TOKEN: undefined } });
    assert.deepEqual(await (await fetch(noTokenUrl + '/api/health')).json(), { ready: false, authRequired: true });
    assert.equal((await anonymousPost(noTokenUrl, '/api/speech', { text: 'hello' })).status, 503);
  }
  assert.equal(calls, 0);
});

test('anonymous demo requests share the existing global quota across both APIs', async t => {
  let calls = 0;
  const url = await start(t, { limits: { requestsPerWindow: 1 }, fetcher: async () => {
    calls++;
    return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } });
  } });
  assert.equal((await anonymousPost(url, '/api/speech', { text: 'hello' })).status, 200);
  const response = await anonymousPost(url, '/api/vision', { image: JPEG, kind: 'ocr' }, { 'x-forwarded-for': '192.0.2.99' });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'Too many requests' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  assert.equal(calls, 1);
});
