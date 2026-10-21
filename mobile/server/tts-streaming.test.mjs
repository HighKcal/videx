import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { request } from 'node:http';
import { createVidexServer } from './server.mjs';

const env = { OPENAI_API_KEY: 'synthetic-only', VIDEX_DEMO_MODE: 'true', VIDEX_ALLOWED_ORIGINS: 'https://tts.example' };
async function start(t, fetcher, limits = {}) {
  const server = createVidexServer({ env, fetcher, limits });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/speech`;
  return Object.assign((signal) => fetch(url, { method: 'POST', headers: { origin: 'https://tts.example', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'synthetic' }), signal }), { url });
}

test('slow TCP consumer backpressures upstream pulls, keeps its slot and disconnect cancels the reader', { timeout: 3000 }, async t => {
  let pulls = 0, cancelled = false, observed, calls = 0;
  const post = await start(t, async (_url, options) => {
    calls++; observed = options.signal;
    if (calls > 1) return new Response('next', { headers: { 'content-type': 'audio/mpeg' } });
    return new Response(new ReadableStream({
      pull(c) { pulls++; c.enqueue(new Uint8Array(65536)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'audio/mpeg' } });
  }, { concurrency: 1 });
  const consumer = await new Promise((resolve, reject) => {
    const req = request(post.url, { method: 'POST', headers: { origin: 'https://tts.example', 'content-type': 'application/json' } }, res => { res.pause(); resolve(res); });
    req.on('error', reject); req.end(JSON.stringify({ text: 'synthetic' }));
  });
  t.after(() => consumer.destroy());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(pulls < 150, `must not drain 10MB upstream while paused; pulls=${pulls}`);
  const stalledAt = pulls;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(pulls, stalledAt, 'pull count must stabilize under TCP backpressure');
  assert.equal((await post()).status, 429);
  consumer.destroy();
  for (let i = 0; !cancelled && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
  assert.equal(observed.aborted, true);
  const stoppedAt = pulls;
  const next = await post();
  assert.equal(next.status, 200); await next.arrayBuffer();
  assert.equal(pulls, stoppedAt);
  t.diagnostic(JSON.stringify({ pausedPulls: stoppedAt, maximumBytesRead: stoppedAt * 65536, cancelled, releasedStatus: next.status }));
});

for (const mode of ['overflow', 'timeout', 'error']) {
  test(`post-header ${mode} destroys MPEG stream, cancels upstream and releases slot without JSON`, { timeout: 2000 }, async t => {
    let source, observed, cancelled = false, calls = 0;
    const post = await start(t, async (_url, options) => {
      calls++; observed = options.signal;
      if (calls > 1) return new Response('next', { headers: { 'content-type': 'audio/mpeg' } });
      return new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'audio/mpeg' } });
    }, { concurrency: 1, upstreamTimeoutMs: mode === 'timeout' ? 100 : 1000 });
    const response = await post();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    const reader = response.body.getReader();
    assert.deepEqual([...((await reader.read()).value)], [1, 2, 3]);
    if (mode === 'overflow') source.enqueue(new Uint8Array(10_000_000));
    if (mode === 'error') source.error(Error('PRIVATE_PROVIDER_DETAILS'));
    await assert.rejects(reader.read());
    assert.equal(observed.aborted, true);
    if (mode !== 'error') assert.equal(cancelled, true);
    const next = await post();
    assert.equal(next.status, 200); await next.arrayBuffer();
  });
}

test('relays the first bytes before upstream EOF without content-length or buffering', { timeout: 2000 }, async t => {
  let upstream, ended = false;
  const post = await start(t, async () => new Response(new ReadableStream({ start(c) { upstream = c; c.enqueue(new Uint8Array([1, 2, 3])); } }), { headers: { 'content-type': 'audio/mpeg' } }));
  const pending = post();
  const response = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 300))]);
  if (!response) { upstream.close(); await pending; }
  assert.ok(response, 'first response bytes must arrive while upstream is still open');
  assert.equal(ended, false);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body.getReader();
  assert.deepEqual([...((await reader.read()).value)], [1, 2, 3]);
  upstream.enqueue(new Uint8Array([4])); ended = true; upstream.close();
  assert.deepEqual([...((await reader.read()).value)], [4]);
  assert.equal((await reader.read()).done, true);
});
