import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { createVidexServer } from './server.mjs';

test('blocked downstream retains the legacy five-second delivery wait bound', { timeout: 7000 }, async t => {
  let cancelled = false, calls = 0;
  const server = createVidexServer({
    env: { OPENAI_API_KEY: 'synthetic-only', VIDEX_DEMO_MODE: 'true', VIDEX_ALLOWED_ORIGINS: 'https://tts.example' },
    limits: { concurrency: 1 },
    fetcher: async () => {
      calls++;
      if (calls > 1) return new Response('next', { headers: { 'content-type': 'audio/mpeg' } });
      return new Response(new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(65536)); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/speech`;
  const headers = { origin: 'https://tts.example', 'content-type': 'application/json' };
  const consumer = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, res => { res.pause(); resolve(res); });
    req.on('error', reject); req.end(JSON.stringify({ text: 'synthetic' }));
  });
  t.after(() => consumer.destroy());
  await new Promise(resolve => setTimeout(resolve, 5500));
  assert.equal(cancelled, true, 'blocked drain must cancel before the longer upstream deadline');
  const next = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'next' }) });
  assert.equal(next.status, 200); await next.arrayBuffer();
});
