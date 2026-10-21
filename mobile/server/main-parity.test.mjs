import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createVidexServer } from './server.mjs';
import { JPEG } from './jpeg-fixture.mjs';
import { parseVisionText } from './vision.mjs';

const MAIN = 'f7f0ea496dc4a06bf15a98eee14e08dea186f071';
const root = fileURLToPath(new URL('../../', import.meta.url));
// Evaluate only constant assignments and HttpVisionClient's class definition
// from the pinned main blobs. No module imports, env/key access or recognize().
const reference = JSON.parse(execFileSync('python', ['-c', `
import ast, base64, json, sys
sources = json.load(sys.stdin)
config = ast.parse(sources['config'])
constants = {}
for node in config.body:
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
        for target in node.targets:
            if isinstance(target, ast.Name): constants[target.id] = ast.literal_eval(node.value)
result = {}
for kind in ('ocr', 'object'):
    tree = ast.parse(sources[kind])
    scope = dict(constants, base64=base64)
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            target = node.targets[0] if isinstance(node, ast.Assign) else node.target
            if isinstance(target, ast.Name):
                try: scope[target.id] = ast.literal_eval(node.value)
                except (ValueError, TypeError): pass
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'HttpVisionClient')
    exec(compile(ast.Module(body=[cls], type_ignores=[]), '<pinned-main-client>', 'exec'), scope)
    client = scope['HttpVisionClient']()
    result[kind] = {'endpoint': client.endpoint, 'timeoutMs': int(client.timeout * 1000), 'payload': client.build_payload(base64.b64decode(sources['image'].split(',')[1]))}
print(json.dumps(result, ensure_ascii=False))
`], {
  input: JSON.stringify({
    config: execFileSync('git', ['show', `${MAIN}:app/text_recognition/config.py`], { cwd: root, encoding: 'utf8' }),
    ocr: execFileSync('git', ['show', `${MAIN}:app/text_recognition/vision.py`], { cwd: root, encoding: 'utf8' }),
    object: execFileSync('git', ['show', `${MAIN}:app/object_recognition/api.py`], { cwd: root, encoding: 'utf8' }),
    image: JPEG,
  }),
  encoding: 'utf8',
}));

const ENV = { OPENAI_API_KEY: 'synthetic-main-parity-key', VIDEX_DEMO_MODE: 'true', VIDEX_ALLOWED_ORIGINS: 'https://videx.example' };
async function start(t, fetcher, options = {}) {
  const server = createVidexServer({ env: ENV, fetcher, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function post(url, kind = 'ocr') {
  return fetch(url + '/api/vision', { method: 'POST', headers: { origin: 'https://videx.example', 'content-type': 'application/json' }, body: JSON.stringify({ image: JPEG, kind }) });
}
function completion(content) { return Response.json({ choices: [{ message: { content } }] }); }

test('outbound OCR and object requests equal pinned main build_payload plus store:false', async t => {
  const calls = [];
  const { url } = await start(t, async (endpoint, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ endpoint, options, payload });
    return completion(payload.response_format ? JSON.stringify({ text: '보이는 글씨\n그대로' }) : '정확한 제품명 1L');
  });
  for (const kind of ['ocr', 'object']) {
    const response = await post(url, kind);
    const call = calls.at(-1);
    assert.equal(call.endpoint, reference[kind].endpoint);
    assert.deepEqual(call.payload, { ...reference[kind].payload, store: false });
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.headers.authorization, `Bearer ${ENV.OPENAI_API_KEY}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { text: kind === 'ocr' ? '보이는 글씨\n그대로' : '정확한 제품명 1L' });
  }
});

test('main provider deadlines are not preempted by the old 12s relay or 15s socket limit', async t => {
  const scheduled = [];
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    scheduled.push(delay);
    return setTimer(callback, delay, ...args);
  });
  let socket;
  const seen = [];
  const { server, url } = await start(t, async (_endpoint, options) => {
    const payload = JSON.parse(options.body);
    seen.push({ scheduled: [...scheduled], socketTimeout: socket.timeout });
    return completion(payload.response_format ? '{"text":""}' : '인식 실패');
  });
  server.prependListener('request', req => { socket = req.socket; });
  for (const kind of ['ocr', 'object']) {
    scheduled.length = 0;
    const response = await post(url, kind);
    assert.equal(response.status, 200);
    await response.json();
    const observation = seen.at(-1);
    assert.ok(observation.scheduled.includes(reference[kind].timeoutMs), `${kind} expected provider deadline ${reference[kind].timeoutMs}; saw ${observation.scheduled}`);
    assert.ok(observation.socketTimeout > reference[kind].timeoutMs, `${kind} socket timeout must leave provider deadline margin`);
  }
});

test('OCR preserves main empty/whitespace/multiline and long text without the former 4000-character slice', async t => {
  let text = '';
  const { url } = await start(t, async () => completion(JSON.stringify({ text })));
  for (text of ['', ' \n\t ', '간판\nEnglish 123 !\n문단 그대로', '긴 원문 '.repeat(3000)]) {
    const response = await post(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text });
  }
});

test('OCR retains the full bounded 8192-token transport budget including heavily escaped JSON', async t => {
  let content = '{"text":"' + '\\uac00'.repeat(65_536) + '"}';
  const { url } = await start(t, async () => completion(content));
  let response = await post(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '가'.repeat(65_536) });
  content = JSON.stringify({ text: 'x'.repeat(65_537) });
  response = await post(url);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Upstream unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('OCR rejects non-string, malformed, duplicate/escaped duplicate and extra JSON fields without fallback', async t => {
  let content;
  const { url } = await start(t, async () => completion(content));
  for (content of [null, 12, [], {}, 'not-json', '[]', '{}', '{"text":null}', '{"text":"a","extra":true}', '{"text":"a","text":"b"}', '{"text":"a","te\\u0078t":"b"}', '"plain string"', '{"text":"a"} trailing']) {
    const response = await post(url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream unavailable' });
  }
});

test('main object parser is plain product-only, quote-normalized, codepoint-bounded and never silently truncated', async t => {
  let content;
  const { url } = await start(t, async () => completion(content));
  for (const [raw, expected] of [['  "서울우유 나100% 1L"  ', '서울우유 나100% 1L'], ["'''제품 1L'''", '제품 1L'], ['인식 실패', '인식 실패'], ['😀'.repeat(100), '😀'.repeat(100)], ['\u001c제품\u0085', '제품']]) {
    content = raw;
    const response = await post(url, 'object');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: expected });
  }
  for (content of ['', ' ', 'x'.repeat(101), '😀'.repeat(101), '첫 줄\n둘째 줄', '첫 줄\r둘째 줄', '{"product_name":"우유"}', '["우유"]', '```우유```', '# 우유', '- 우유', '제품명: 우유', 'PRODUCT_NAME\u0085=Milk']) {
    const response = await post(url, 'object');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream unavailable' });
  }
});

test('strict parsers match executable parse functions extracted from pinned main', () => {
  const cases = {
    ocr: ['{"text":""}', '{"text":" \\n "}', '{"text":"a \\\"text\\\": b"}', '[]', '{"text":"a","text":"b"}', '{"text":"a","te\\u0078t":"b"}', '{"text":12}', '{"text":"a","extra":0}'],
    object: ['"제품 1L"', "'' 우유 ''", '인식 실패', '😀'.repeat(100), '😀'.repeat(101), '\u001c우유\u0085', '\ufeff우유\ufeff', 'PRODUCT_NAME\u0085: milk', '제품명 = 우유', 'a\nb', '- a', '# a', '[a]', '```a```'],
  };
  const results = JSON.parse(execFileSync('python', ['-c', `
import ast, json, re, sys
data = json.load(sys.stdin)
results = {}
for kind, name in [('ocr', 'parse_text_response'), ('object', 'parse_product_name')]:
    tree = ast.parse(data['sources'][kind])
    fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    scope = {'json': json, 're': re, 'VisionResponseError': ValueError, 'VisionApiError': ValueError}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), '<pinned-main-parser>', 'exec'), scope)
    results[kind] = []
    for raw in data['cases'][kind]:
        try:
            value = scope[name](raw)
            results[kind].append({'text': value['text'] if kind == 'ocr' else value})
        except ValueError: results[kind].append({'rejected': True})
print(json.dumps(results, ensure_ascii=False))
`], {
    input: JSON.stringify({ cases, sources: {
      ocr: execFileSync('git', ['show', `${MAIN}:app/text_recognition/vision.py`], { cwd: root, encoding: 'utf8' }),
      object: execFileSync('git', ['show', `${MAIN}:app/object_recognition/api.py`], { cwd: root, encoding: 'utf8' }),
    } }), encoding: 'utf8',
  }));
  for (const kind of ['ocr', 'object']) {
    const actual = cases[kind].map(content => {
      try { return { text: parseVisionText(kind, { choices: [{ message: { content } }] }) }; }
      catch { return { rejected: true }; }
    });
    assert.deepEqual(actual, results[kind], kind);
  }
});

test('vision envelopes remain bounded on advertised and streamed overflow, not silently truncated', async t => {
  let advertised = true;
  const { url } = await start(t, async () => new Response(advertised ? '{}' : 'x'.repeat(1_048_577), { headers: { 'content-type': 'application/json', ...(advertised ? { 'content-length': '1048577' } : {}) } }));
  for (advertised of [true, false]) {
    const response = await post(url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('only Chat Completions choices[0].message.content string is accepted', async t => {
  let body;
  const { url } = await start(t, async () => Response.json(body));
  for (body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: [{ type: 'text', text: 'hello' }] } }] }, { output: [{ content: [{ type: 'output_text', text: 'legacy Responses shape' }] }] }]) {
    const response = await post(url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream unavailable' });
  }
});
