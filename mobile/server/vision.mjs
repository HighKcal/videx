// Recognition defaults copied from GitHub main f7f0ea496dc4a06bf15a98eee14e08dea186f071.
// Keep transport resource limits separate from semantic output parsing.
export const VISION_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const MAX_VISION_TEXT_LENGTH = 65_536;
export const MAX_VISION_RESPONSE_BYTES = 1_048_576;
export const VISION_TIMEOUT_MS = Object.freeze({ ocr: 30_000, object: 20_000 });

const TEXT_RECOGNITION_PROMPT = `당신은 시각장애인을 위한 범용 이미지 텍스트 인식 시스템입니다.

입력된 이미지에 실제로 보이는 글씨를 가능한 한 정확하게 추출하세요.

이미지에는 간판, 책, 표지판, 문서, 메뉴판, 포스터, 팸플릿 등 다양한 글씨가 포함될 수 있습니다.

규칙:

1. 이미지에 실제로 보이는 한글, 영어, 숫자, 기호를 최대한 정확하게 인식하세요.
2. 이미지에 보이지 않는 단어나 문장을 추측하여 생성하지 마세요.
3. 원문을 요약하거나 번역하지 마세요.
4. 여러 줄의 글씨는 자연스러운 읽기 순서대로 정리하세요.
5. 책이나 문서의 경우 문장과 문단 순서를 최대한 유지하세요.
6. 간판과 안내판의 경우 명확하게 보이는 텍스트를 자연스러운 순서로 추출하세요.
7. 메뉴판과 목록은 항목별 줄바꿈을 유지하세요.
8. 여러 단으로 나뉜 문서는 가능한 한 단별 읽기 순서를 유지하세요.
9. 불분명한 글자를 임의로 완성하지 마세요.
10. 글씨의 의미나 이미지 속 배경을 설명하지 마세요.
11. 글씨가 없다면 빈 문자열을 반환하세요.
12. 반드시 유효한 JSON 객체 하나만 반환하세요.
13. JSON 외에는 어떤 설명도 추가하지 마세요.

응답 형식:

{
  "text": "이미지에서 인식한 글씨"
}`;
const PRODUCT_PROMPT = '이미지에 있는 제품의 정확한 제품명만 출력하세요. 브랜드와 용량이 제품명에 포함되어 있다면 유지하세요. 설명이나 다른 문장은 출력하지 마세요. 식별할 수 없다면 \'인식 실패\'만 출력하세요.';

export function buildVisionPayload(kind, image) {
  const content = [
    { type: 'text', text: kind === 'ocr' ? '이 이미지에 실제로 보이는 글씨를 JSON으로 추출하세요.' : PRODUCT_PROMPT },
    { type: 'image_url', image_url: { url: image, detail: 'high' } },
  ];
  const payload = {
    model: 'gpt-4.1-mini',
    messages: kind === 'ocr'
      ? [{ role: 'system', content: TEXT_RECOGNITION_PROMPT }, { role: 'user', content }]
      : [{ role: 'user', content }],
    max_completion_tokens: kind === 'ocr' ? 8192 : 48,
    n: 1,
    temperature: 0,
    // Additive privacy policy, intentionally absent from the main Python payload.
    store: false,
  };
  if (kind === 'ocr') payload.response_format = {
    type: 'json_schema',
    json_schema: {
      name: 'videx_text_recognition', strict: true,
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
  };
  return payload;
}

// Python str.strip()/re \s include these characters (not JS's extra BOM).
const PYTHON_SPACE = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const stripSpace = new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, 'g');
const productField = new RegExp(`^(product_name|제품명)${PYTHON_SPACE}*[:=]`, 'i');
function parseProductName(raw) {
  const value = raw.replace(stripSpace, '').replace(/^["']+|["']+$/g, '').replace(stripSpace, '');
  if (value === '인식 실패') return value;
  if (!value || Array.from(value).length > 100 || /[\n\r]/.test(value) || /^(?:\{|\[|```|#|- )/.test(value) || productField.test(value)) throw Error('Invalid product result');
  return value;
}
function parseTextResponse(raw) {
  // JSON.parse alone silently accepts duplicate keys, unlike main's parser.
  const keys = new Set();
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!raw.slice(match.index + match[0].length).trimStart().startsWith(':')) continue;
    const key = JSON.parse(match[0]);
    if (keys.has(key)) throw Error('Duplicate text field');
    keys.add(key);
  }
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text') || typeof value.text !== 'string' || value.text.length > MAX_VISION_TEXT_LENGTH) throw Error('Invalid text result');
  return value.text;
}
export function parseVisionText(kind, data) {
  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw Error('Invalid completion');
  return kind === 'ocr' ? parseTextResponse(raw) : parseProductName(raw);
}
