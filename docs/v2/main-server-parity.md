# Main recognition server parity — final contract / frozen

Task `main-server-parity`; baseline is exact fetched GitHub main SHA `f7f0ea496dc4a06bf15a98eee14e08dea186f071`, inspected with `git show`, not the dirty firmware/mobile tree. Write scope: `mobile/server/*` and this document only. Preserve all CDC/buttons/preview/consent/security changes. No firmware, secrets-file reads, paid API calls, shared-server restart, build, E2E, commit, push or reset.

## Immediate frontend / fixture handoff

- Browser contract remains `POST /api/vision {image,kind}` -> `{text}`. Fixed provider endpoint is `https://api.openai.com/v1/chat/completions`, model `gpt-4.1-mini`, `temperature:0`, `n:1`, image `detail:"high"`. `store:false` is retained as an explicit additive privacy deviation from main; no Responses API envelope.
- Provider result is `choices[0].message.content`, strictly a string. OCR: this string must be JSON with exactly one unique `text` key whose value is a string; empty `""` is valid. Object: the string is a strict plain product name (or `인식 실패`), parsed using main's quote trimming, length, newline, prefix and field-label rules. Do not return OCR's JSON string literally or concatenate Responses output fragments.
- OCR payload: exact main system prompt `TEXT_RECOGNITION_PROMPT` plus exact user text `이 이미지에 실제로 보이는 글씨를 JSON으로 추출하세요.`, strict named JSON schema `videx_text_recognition` (`text:string`, required, no extra keys), `max_completion_tokens:8192`, provider deadline 30000 ms.
- Object payload: exact main `PRODUCT_PROMPT` in the user message, no system message/response_format added, `max_completion_tokens:48`, provider deadline 20000 ms. Product output maximum is 100 Unicode code points, matching Python `len`, after main normalization; no invented truncation.
- Agreed bounded browser/server OCR text support: maximum 65536 JavaScript UTF-16 code units, without slicing/truncation. Reject over-budget upstream output with generic 502 rather than silently returning shortened text. This is a transport safety ceiling, not a claim of unbounded exact-main output acceptance. Vision JSON envelope ceiling is 1048576 bytes, server upstream and recommended client response budget; this allows the 8192-token request to return long escaped text without the former 4000-character slice/262144-byte envelope bottleneck.
- Client/fixture handoff: support OCR empty strings and >4000-character OCR text through the stated cap; fixtures must return Chat Completions choices/message/content (OCR inner JSON, object plain product name). Recommended client vision deadline at least 45000 ms (up to 10000 ms upload budget + 30000 ms OCR provider budget plus margin), with an action cancellation deadline exceeding it. Server provider budgets remain exact main 30000/20000 ms; user cancellation/disconnect still aborts. Frontend peer owns these client/E2E edits and local-speech default restoration.
- Optional existing server speech technology is not replaced. Its input/provider limits remain separate from long OCR; local speech restoration belongs to frontend. Exact comparison and actual server-only verification are recorded below.

## Exact comparison against main

The old mobile relay's Responses endpoint, OCR short paraphrase, object descriptive summary, 800-token budget, 12-second deadline and 4000-character response slicing were not equivalent to main. `mobile/server/vision.mjs` now owns main-compatible payload/result semantics; no recognition behavior is inferred from dirty source or an unpinned branch name.

| Contract item | Main baseline / restored server behavior |
| --- | --- |
| Source | `app/text_recognition/config.py`, `app/text_recognition/vision.py`, `app/object_recognition/api.py` at the exact SHA above |
| Endpoint/model | Chat Completions, `gpt-4.1-mini`, for both kinds |
| OCR messages | Exact `TEXT_RECOGNITION_PROMPT` system content, exact user text quoted above, one JPEG image with `detail:high` |
| OCR format/options | Named strict JSON schema `videx_text_recognition`, exactly `text:string`, no additional fields, `max_completion_tokens:8192`, `temperature:0`, `n:1` |
| Object messages/options | Exact `PRODUCT_PROMPT` as user text; no added system message/schema; one high-detail JPEG; `max_completion_tokens:48`, `temperature:0`, `n:1` |
| Result envelope | First choice's message content string only; no Responses fallback or output concatenation |
| OCR parser | Exact unique-key JSON object with string `text`, including empty and whitespace strings; no trimming/summarizing/truncating |
| Object parser | Main quote/whitespace normalization, Unicode-codepoint length <=100, single line, reject JSON/list/markdown/field-prefixed replies; accept `인식 실패`; no truncation |
| Provider timeouts | OCR 30000 ms / object 20000 ms; lower test/operator limits can shorten but cannot expand these budgets |

Parity is executable, not only duplicated expectations: `mobile/server/main-parity.test.mjs` uses `git show <exact SHA>:<path>` then Python AST extraction to obtain constants and the actual `HttpVisionClient` class definitions. It calls only constructors/build_payload on fixture bytes, never `recognize()`, configuration validation or application imports/env access, and compares the resulting complete outbound HTTP payload plus explicit `store:false`. A separate differential test evaluates the actual pinned main parse functions against the JS parser, including duplicate/escaped keys, empty OCR, Unicode whitespace/BOM and Unicode-codepoint object lengths. This catches prompt/user-text/schema/default drift without using production credentials or real upstream requests.

Test portability: this parity test intentionally requires Python 3, Git and the fetched SHA object in the checkout. It fails if that reference is unavailable; it does not silently substitute copied expected prompts. Production imports only `vision.mjs`; no runtime Git/Python dependency or subprocess is introduced into serving.

## Deliberate retained boundaries / differences

- `store:false` is additive privacy policy absent from main's Python payload. HTTP errors remain generic no-store errors instead of exposing main's detailed error categories/provider diagnostics.
- OCR text and upstream envelope remain bounded at the published 65536 UTF-16 units / 1048576 bytes. Main's parser has no corresponding general OCR text cap. Over-budget data is rejected, not sliced; do not claim unlimited acceptance parity or a guarantee about every possible 8192-token output. Regression proves long and heavily escaped text, including the text cap, survives without the old 4000-character/262144-byte truncation bottleneck.
- Default upstream ceiling was raised to 30000 ms solely to allow the exact kind-specific budgets. Optional server speech stays at its previous 12000 ms. Completed-upload sockets receive the selected upstream deadline plus 5000 ms inactivity margin, so the old 15000 ms socket timer cannot silently preempt OCR. Upload body timeout remains 10000 ms; header/upload safeguards, cancellation and quotas remain bounded.
- Fixed schema `{image,kind}`, exact allowed-Origin check, server-only provider credential, authenticated/default and explicit demo gates, same-origin CSP, no-store responses, redirect rejection, JPEG envelope validation, global 30-per-window/2-concurrency controls, disconnect abort and no provider-content logging were preserved and tested. Server cannot attest to client-side consent provenance; existing client consent/selection remains independently required.
- `mobile/server/jpeg.mjs` is unchanged structural JPEG/base64/dimension/pixel-envelope validation, not a blur/contrast/lighting classifier. No server blur heuristic was added or changed. Frontend image-quality acceptance changes are peer-owned and are not claimed as implemented here.
- Existing dirty static/CSP changes were preserved; `mobile/server/static.test.mjs` was already modified before this task and was not edited by this worker.

## Speech comparison (not a new server TTS implementation)

`git show <exact SHA>:proxy/local_speech.py` defines offline laptop `pyttsx3` speech: Korean voice preference, rate 175, bounded queue of 8, generation-based cancellation, and `engine.say(text)` without HTTP. The previous mobile server's optional OpenAI TTS is therefore not main's local-speech technology. It remains unchanged (`gpt-4o-mini-tts`, coral/mp3, 4000-character input cap, 12000 ms provider deadline); no new server engine was introduced. Frontend peer restores local/default speech behavior, subject to browser/OS voice availability/policy. This server task does not claim identical laptop/browser voice quality, offline behavior or long-text speech acceptance through the optional 4000-character server endpoint.

## Actual RED / GREEN and regression evidence

Working directory for commands: `/home/minwoo/.superset/projects/videx/mobile`. All HTTP exercises used test-owned loopback ephemeral ports, explicit synthetic environments and injected provider responses. No shared server was restarted, no paid upstream request occurred, and no build/E2E was run by this worker.

- RED: `node --test server/main-parity.test.mjs` — exit 1, 0 pass / 1 fail. Actual outbound endpoint was `https://api.openai.com/v1/responses`; pinned main expected `https://api.openai.com/v1/chat/completions`.
- GREEN after payload/parser slice: same command — exit 0, 1/1 pass, complete OCR/object payloads equal executable pinned-main payloads plus `store:false`.
- RED after deadline regression: same command — exit 1, 1 pass / 1 fail. OCR expected 30000 ms; scheduled values included 10000 and 12000, exposing the old provider deadline.
- GREEN after kind-specific timer/socket correction: same command — exit 0, 2/2 pass, verifies both exact provider defaults and socket margin.
- Expanded affected server check: `node --test server/main-parity.test.mjs server/server.test.mjs server/demo.test.mjs` — exit 0, 30/30 pass. Covers empty/long/escaped OCR, strict duplicate-key rejection, object parsing, response-byte bounds, fixed schemas, origin/auth/demo gates, quotas, cancellation/no-store/no-log and stream cleanup.
- Final server-only suite: `npm run test:server` — exit 0, 34/34 pass, no skipped/cancelled tests. Includes isolated CLI startup/static safety tests using existing dist; it does not build or restart the shared runtime.
- `node --check mobile/server/vision.mjs` and `node --check mobile/server/main-parity.test.mjs` from repo root — exit 0. Scoped `git diff --check -- mobile/server docs/v2/main-server-parity.md` — exit 0 before this final documentation update; tracked-diff checks do not cover untracked files.

## Exact worker changes / freeze

- `mobile/server/vision.mjs` — new fixed main payloads, strict result parsing, named deadlines/text/envelope budgets.
- `mobile/server/server.mjs` — switch relay to Chat Completions helper; preserve public request contract/security; use kind-specific deadlines and sufficient completed-upload socket margin; remove text slicing.
- `mobile/server/main-parity.test.mjs` — new exact-SHA executable payload/parser parity and real loopback HTTP regressions.
- `mobile/server/server.test.mjs` — migrate provider fixtures/assertions to Chat Completions and new bounded response envelope while retaining existing safety tests.
- `mobile/server/demo.test.mjs` — migrate successful anonymous OCR fixture to Chat Completions JSON text.
- `docs/v2/main-server-parity.md` — early contract, exact comparison, speech distinction, evidence and handoff.

Server sources/tests are frozen after the passing server suite; only this documentation was finalized afterward. Frontend/E2E fixture migrations, client long/empty-text handling and deadlines, local speech default and combined acceptance are peer/parent-owned. Parent owns combined build/E2E/shared ports and public runtime verification. Real board image acceptance/quality, paid provider behavior, actual answer accuracy and physical speech quality remain unverified; no firmware/commit/push/reset or secrets-file access occurred.

SUPERSET_WORKER_DONE task:main-server-parity result:exact-main ChatCompletions payload/defaults/parsers restored with documented privacy/resource bounds;server frozen files:mobile/server/vision.mjs;mobile/server/server.mjs;mobile/server/main-parity.test.mjs;mobile/server/server.test.mjs;mobile/server/demo.test.mjs;docs/v2/main-server-parity.md checks:RED endpoint/deadline observed;GREEN exact-SHA payload/parser parity;server-only suite 34/34 PASS handoff:frontend text/deadline/local-speech/E2E peer-owned;parent combined validation;real hardware/provider/quality unverified
