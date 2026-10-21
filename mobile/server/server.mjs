import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { validJpegDataUrl } from './jpeg.mjs';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static.mjs';
import { buildVisionPayload, parseVisionText, VISION_ENDPOINT, VISION_TIMEOUT_MS, MAX_VISION_RESPONSE_BYTES } from './vision.mjs';

const DEFAULT_LIMITS = Object.freeze({ requestsPerWindow: 30, windowMs: 60_000, concurrency: 2, upstreamTimeoutMs: 30_000, bodyTimeoutMs: 10_000 });

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function configuration(env) {
  const errors = [];
  const authRequired = env.VIDEX_DEMO_MODE !== 'true';
  const key = env.OPENAI_API_KEY;
  const token = env.VIDEX_ACCESS_TOKEN;
  if (typeof key !== 'string' || !key.trim() || /[\s\x00-\x1f\x7f]/.test(key)) errors.push('OPENAI_API_KEY');
  if (authRequired && (typeof token !== 'string' || token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token) || token === key)) errors.push('VIDEX_ACCESS_TOKEN');
  const origins = new Set();
  try {
    if (typeof env.VIDEX_ALLOWED_ORIGINS !== 'string') throw Error();
    for (const value of env.VIDEX_ALLOWED_ORIGINS.split(',')) {
      const origin = value.trim();
      const u = new URL(origin);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.origin !== origin || u.username || u.password || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) throw Error();
      origins.add(origin);
    }
  } catch {
    errors.push('VIDEX_ALLOWED_ORIGINS');
  }
  return { ready: errors.length === 0, authRequired, errors, key, origins, tokenDigest: digest(typeof token === 'string' ? `Bearer ${token}` : '') };
}

export function configurationIssues(env) {
  return configuration(env).errors;
}

function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  if (!res.req.complete) res.setHeader('connection', 'close');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req, limit) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) throw new RequestError(415, 'Unsupported media type');
  if (Number(req.headers['content-length']) > limit) throw new RequestError(413, 'Request too large');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RequestError(400, 'Invalid request'); }
}

function strictObject(body, keys) {
  return body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
}

function abortable(signal, operation) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readUpstream(response, vision, signal) {
  const limit = vision ? MAX_VISION_RESPONSE_BYTES : 10_000_000;
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || response.redirected || type !== (vision ? 'application/json' : 'audio/mpeg') || Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw Error();
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error();
      chunks.push(Buffer.from(value));
    }
    if (!size) throw Error();
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function audioWritable(res, signal, event, write) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      res.removeListener(event, ready);
      res.removeListener('close', closed);
      res.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const closed = () => finish(Error('Disconnected'));
    const failed = error => finish(error);
    const aborted = () => finish(signal.reason);
    // Keep the legacy downstream delivery bound even when the provider's
    // overall deadline is longer. Never leave a blocked drain/finish waiting.
    const timer = setTimeout(() => finish(Error('Audio delivery timed out')), 5000);
    res.once(event, ready);
    res.once('close', closed);
    res.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (res.destroyed) throw Error('Disconnected');
      if (write() && event === 'drain') finish();
    } catch (error) { finish(error); }
  });
}

async function relayAudio(res, response, signal) {
  const limit = 10_000_000;
  if (!response.ok || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg' || Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw Error();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(signal, () => reader.read());
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error();
      if (!value.byteLength) continue;
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      for (let offset = 0; offset < value.length; offset += 65536) {
        await audioWritable(res, signal, 'drain', () => res.write(value.subarray(offset, offset + 65536)));
      }
    }
    if (!size) throw Error();
    await audioWritable(res, signal, 'finish', () => res.end());
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function createVidexServer({ env = process.env, fetcher = globalThis.fetch, limits = {}, now = () => performance.now(), distDir = fileURLToPath(new URL('../dist', import.meta.url)) } = {}) {
  const config = configuration(env);
  const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.entries(limits).some(([key, value]) => !Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key])) throw Error('Invalid server limits');
  const quota = { ...DEFAULT_LIMITS, ...limits };
  let windowStart = now(), requests = 0, active = 0;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000, connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, async (req, res) => {
    res.setHeader('content-security-policy', csp);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('x-frame-options', 'DENY');
    if (req.url === '/api/health') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      return json(res, 200, { ready: config.ready, authRequired: config.authRequired });
    }
    if (!['/api/health', '/api/vision', '/api/speech'].includes(req.url)) {
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      if (await serveStatic(req, res, distDir)) return;
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (!config.ready) return json(res, 503, { error: 'Service unavailable' });
    for (const name of ['authorization', 'origin', 'content-type', 'content-length']) {
      let count = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
      if (count > 1) return json(res, 400, { error: 'Invalid request' });
    }
    if (config.authRequired && !timingSafeEqual(digest(req.headers.authorization ?? ''), config.tokenDigest)) return json(res, 401, { error: 'Unauthorized' });
    if (!config.origins.has(req.headers.origin)) return json(res, 403, { error: 'Forbidden' });
    const time = now();
    if (time - windowStart >= quota.windowMs) { windowStart = time; requests = 0; }
    if (requests >= quota.requestsPerWindow || active >= quota.concurrency) {
      res.setHeader('retry-after', String(requests >= quota.requestsPerWindow ? Math.max(1, Math.ceil((windowStart + quota.windowMs - time) / 1000)) : 1));
      return json(res, 429, { error: 'Too many requests' });
    }
    requests++;
    active++;
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(Error('Disconnected')); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    let timer = setTimeout(() => controller.abort(new RequestError(408, 'Request timed out')), quota.bodyTimeoutMs);
    let bodyRead;
    try {
      const vision = req.url === '/api/vision';
      bodyRead = readJson(req, vision ? 8_000_128 : 16_384);
      const body = await abortable(signal, () => bodyRead);
      clearTimeout(timer);
      if (vision ? (!strictObject(body, ['image', 'kind']) || !['ocr', 'object'].includes(body.kind) || !validJpegDataUrl(body.image)) : (!strictObject(body, ['text']) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000)) throw new RequestError(400, 'Invalid request');
      const payload = vision ? buildVisionPayload(body.kind, body.image)
        : { model: 'gpt-4o-mini-tts', voice: 'coral', input: body.text, response_format: 'mp3', instructions: 'Speak clearly in Korean, naturally and concisely.' };
      const upstreamTimeoutMs = Math.min(quota.upstreamTimeoutMs, vision ? VISION_TIMEOUT_MS[body.kind] : 12_000);
      // The request body is complete. Do not let the upload socket inactivity
      // default preempt main's longer OCR deadline while the provider works.
      req.setTimeout(upstreamTimeoutMs + 5000);
      timer = setTimeout(() => controller.abort(new RequestError(504, 'Upstream timed out')), upstreamTimeoutMs);
      const response = await abortable(signal, async () => {
        const response = await fetcher(vision ? VISION_ENDPOINT : 'https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
        if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
        return response;
      });
      if (vision) {
        const bytes = await abortable(signal, () => readUpstream(response, true, signal));
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return json(res, 200, { text: parseVisionText(body.kind, data) });
      }
      await relayAudio(res, response, signal);
    } catch (error) {
      controller.abort(error);
      if (res.headersSent) { res.destroy(); return; }
      const uploadTimedOut = error instanceof RequestError && error.status === 408;
      const stopUpload = () => {
        res.removeListener('finish', stopUpload);
        res.removeListener('close', stopUpload);
        req.destroy();
      };
      if (uploadTimedOut) {
        // Preserve the safe 408 response before destroying the incomplete reader.
        res.once('finish', stopUpload);
        res.once('close', stopUpload);
      }
      json(res, error instanceof RequestError ? error.status : 502, { error: error instanceof RequestError ? error.message : 'Upstream unavailable' });
      if (uploadTimedOut) {
        if (res.writableFinished || res.destroyed) stopUpload();
        // A rejected race alone does not settle IncomingMessage's pending read.
        await bodyRead?.catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      req.removeListener('aborted', disconnected);
      res.removeListener('close', disconnected);
      active--;
    }
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on('checkContinue', (_req, res) => json(res, 417, { error: 'Invalid request' }));
  server.on('checkExpectation', (_req, res) => json(res, 417, { error: 'Invalid request' }));
  server.on('clientError', (error, socket) => {
    if (!socket.writable || socket.writableEnded || socket.destroyed) return;
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    const body = JSON.stringify({ error: 'Invalid request' });
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  return server;
}
