# Server API backend handoff — backend

Status: DONE; backend implementation/tests/docs FROZEN for coordinator integration and security review. Work was confined to `/home/minwoo/.superset/projects/videx`, actual uncommitted v2 on main. No old worktree, peer file, firmware, Android CDC or walking-mode feedback file was changed.

## Delivered files

- `mobile/server/index.mjs`: runnable Node built-in entry; validated bind settings, safe config-name-only diagnostics and shutdown.
- `mobile/server/server.mjs`: exported `createVidexServer({env,fetcher,distDir,limits,now})`; health, exact API routes, configuration/auth/origin/schema checks, fixed provider requests, global quota/concurrency, bounded upstream response/deadlines/cancellation, safe JSON/no-store errors.
- `mobile/server/jpeg.mjs`: bounded canonical JPEG data URL and structural JPEG validation.
- `mobile/server/static.mjs`: restricted built-dist serving, traversal/symlink/descriptor checks; no source/config/API fallback serving.
- `mobile/server/server.test.mjs`, `static.test.mjs`, `startup.test.mjs`, `jpeg-fixture.mjs`: real random-port HTTP/process integration, synthetic credentials/injected upstream only, locally generated 1x1 JPEG fixture.
- `docs/v2/server-api.md`: complete contract, setup, limit, privacy, TLS/proxy and credential rotation guidance.
- This handoff. No package/frontend/config edits.

## Real verification commands/results

Runtime checked: `node --version` → `v26.10.0`. Repository checked with `pwd`, `git status --short`, `git branch --show-current` → required root/main with pre-existing dirty/untracked v2 changes preserved. Applicable ancestor repo instructions were searched; no root/mobile AGENTS.md, CLAUDE.md or .cursorrules was present. Manifest, original client prompts, Vite CSP/build configuration and existing dist were inspected without reading secret files.

TDD: test first, executed RED, then implementation and GREEN for successive behavior slices: initial missing server; configured auth/origin readiness; speech; vision; provider response bounds; quota/concurrency; timeout/disconnect; static serving; startup; ambiguous headers/health methods/invalid limiter configuration; HTTP parser and slow audio delivery. RED failures were observed and fixed rather than replaced with fabricated output. The initial empty implementation was only the first passing slice, not the deliverable.

Original freeze executions (19 tests; superseded by the 20-test upload-timeout follow-up below):

1. From `/home/minwoo/.superset/projects/videx`:
   `node --test mobile/server/*.test.mjs`
   PASS: tests 19, pass 19, fail 0, cancelled 0, skipped 0, todo 0; duration 490.363831 ms.
2. From `/home/minwoo/.superset/projects/videx/mobile`:
   `node --test server/*.test.mjs`
   PASS: tests 19, pass 19, fail 0, cancelled 0, skipped 0, todo 0; duration 488.317 ms. Same suite, not 38 distinct tests.
3. From repository root:
   `for file in mobile/server/*.mjs; do node --check "$file" || exit; done`
   PASS: exit 0, no syntax diagnostics.
4. `git diff --check`
   PASS: exit 0, no diagnostics. Note these new backend files are untracked within the existing untracked mobile tree; syntax and HTTP tests explicitly exercised them rather than relying on tracked diff checks.

Both test invocations use random ports, including sanitized child-process starts from root and mobile. The startup test actually fetched existing built VIDEX HTML and a referenced JS asset, checked unconfigured health/API failure, then stopped its own child processes. No persistent service or Vite dev server was started. Static fixture directories are created only inside `mobile/server` and cleaned up.

Coverage includes exact bearer/provider credential separation, required exact non-null Origin, no CORS grants, strict malformed/extra/missing/oversize/UTF-8/encoding/JPEG rejection, fixed models/prompts/store:false/max_output_tokens, MP3 success/no-store, global shared quota despite spoofed forwarding headers, concurrency and delivery backpressure, upload/upstream timeout and disconnect abort, bounded streamed/advertised provider bytes, generic errors/no logs, parser/header bounds, traversal/symlinks, CSP/security headers, methods and real CLI/static integration. Upstream data in tests is explicitly synthetic; no paid API request was sent.

## Exact startup environment/port templates — NOT executed by worker

Use a trusted service environment/secret manager. Placeholders below are documentation only; do not write secret files or put real values in frontend builds, support logs, URLs or shell history. `VIDEX_ACCESS_TOKEN` is distinct from `OPENAI_API_KEY` and must be random, at least 32 and at most 512 visible ASCII characters without whitespace.

From `/home/minwoo/.superset/projects/videx`:

```sh
env OPENAI_API_KEY='<SERVER_ONLY_OPENAI_KEY>' \
    VIDEX_ACCESS_TOKEN='<DISTINCT_RANDOM_SERVER_ACCESS_TOKEN_MINIMUM_32_CHARACTERS>' \
    VIDEX_ALLOWED_ORIGINS='https://<PUBLIC_APP_HOST>' \
    HOST='127.0.0.1' PORT='8787' node mobile/server/index.mjs
```

From `/home/minwoo/.superset/projects/videx/mobile`:

```sh
env OPENAI_API_KEY='<SERVER_ONLY_OPENAI_KEY>' \
    VIDEX_ACCESS_TOKEN='<DISTINCT_RANDOM_SERVER_ACCESS_TOKEN_MINIMUM_32_CHARACTERS>' \
    VIDEX_ALLOWED_ORIGINS='https://<PUBLIC_APP_HOST>' \
    HOST='127.0.0.1' PORT='8787' node server/index.mjs
```

With securely injected environment: `node mobile/server/index.mjs` (root), or `node server/index.mjs` (mobile). Defaults are HOST=127.0.0.1 and PORT=8787. Development browser origin can be exactly `http://localhost:5173` (or the actual exact loopback origin/port); Vite `/api` proxy target is `http://127.0.0.1:8787`. Public origins require HTTPS; no trailing slash/path/wildcard. Production reverse proxy must preserve Authorization and actual Origin and serve both frontend/API under the same public origin.

Missing/invalid required API env: server remains available for static files and `GET /api/health` → `{ready:false,authRequired:true}` in default mode or `{ready:false,authRequired:false}` only in explicit demo mode; paid routes → safe 503 without upstream. Invalid bind settings fail startup (exit 1). Health does not verify real provider access/billing and returns no credentials. Startup never reads `.env` or any credential file.

## Coordinator integration gates / stop boundary

- KEEP `Origin:null` and missing Origin rejected. Coordinator reports the frontend same-origin referrer-policy correction and actual browser/backend integration are now green. This backend has not weakened the allowlist or edited peer transport code; response Referrer-Policy remains no-referrer. This is attributed coordinator evidence, not a browser rerun by this worker.
- Current backend tests are 25/25 after the authorized demo-backend change below. Parent previously reported its union green at 57 unit / 19 server / 9 E2E; that report predates these follow-ups. Frontend/browser suites, proxy-through-Vite, production TLS/ingress, real provider/permissions/quality/billing and physical mobile/device validation are NOT newly executed by this worker.
- Process-local limits: 30 allowed-origin attempts passing the current auth mode's gate per 60 s across both routes (including anonymous demo requests); 2 concurrent operations; 10 s upload/12 s upstream/5 s audio delivery. Restart resets quota; replicas need a shared reviewed quota boundary/provider spend limit before scaling. Shared bearer is not multi-user identity/auth issuance; demo has no bearer access control at all.
- All static/API HTTP responses are no-store; frontend worker must remain public-static-only. `_headers` is not loaded as server config: CSP is actively set from reviewed policy and public deployment deviceHost. Keep dist immutable/non-symlink and deviceHost consistent with build.
- The current peer security review's specific upload-timeout resource concern was reproduced and fixed as recorded below. The reviewer-owned security review document was read, not edited. Review the final frozen code and this new evidence rather than earlier TDD snapshots.
- No commit, push, flash, deployment, package installation, runtime/secret provisioning, real keys tested/printed, `.env`/secret file read, or existing live server restart/kill. All existing unrelated changes remain untouched.

## Upload-timeout review follow-up — verdict and real evidence

- Verdict: confirmed a retained pending body-reader/accounting defect, not an observed ability to continue receiving bytes after socket closure. On unchanged production code, a real TCP client with `allowHalfOpen:true`, valid synthetic bearer/Origin and unfinished chunked Vision JSON received safe 408/Connection:close. After 3 seconds, server socket was destroyed but request `destroyed:false`, pending iterator reads=1, consumed bytes=10. The targeted regression timed out (RED).
- Narrow fix in `server.mjs` only: retain the body-read promise; after upload timeout send the generic 408, destroy the request on response finish/close, then await reader settlement before `active--`. This preserves the HTTP error response while eliminating the orphan read. No auth/origin/provider/static/limit-policy changes.
- Added one real-socket regression in `server.test.mjs`, observing the actual iterator's `next()` without adding a flowing-mode data listener. It sends no final chunk or client FIN, attempts a further 4096-byte chunk after receiving the 408, and checks server/request destruction, zero pending reads, exactly 10 original bytes consumed, no upstream timeout call, and concurrent slot 429-before / 200-after cleanup. Only that subsequent valid speech request makes one injected upstream call.
- Focused command from root: `node --test --test-name-pattern='slow chunked upload timeout' mobile/server/server.test.mjs`. GREEN: 1/1; then the same exact command was executed 10 times using a Python `subprocess.run` loop, PASS 10/10, fail 0. Last run: socketDestroyed=true, readerPending=0, consumedBytes=10, attemptedLateBytes=4096, slotStatusBefore=429, slotStatusAfter=200; test 225.91967 ms. Temporary raw-response diagnostic instrumentation was removed; only bounded non-sensitive test diagnostics remain.
- Final full root command: `node --test mobile/server/*.test.mjs` → tests 20, pass 20, fail 0, cancelled 0, skipped 0, todo 0; duration 697.536356 ms. Includes prior 19 tests unchanged plus this one regression.
- `node --check mobile/server/server.mjs && node --check mobile/server/server.test.mjs && git diff --check` → exit 0. No frontend/browser suite rerun, paid API, secret/runtime setup, package/build/Vite/deployment action, or peer/reviewer-file modification. Existing startup templates/port above are unchanged. Implementation and docs are frozen again for the parent's final review/union check.

## Authorized demo-backend — current frozen contract and verification

- User explicitly authorized token-free public demo access. Exactly `VIDEX_DEMO_MODE=true` (the exact string) enables it. Default/unset and every other value retain the original token validation and bearer gate. The flag is read only from the server environment at startup, never from HTTP input.
- Demo still requires `OPENAI_API_KEY` and valid `VIDEX_ALLOWED_ORIGINS`, but does not require/validate `VIDEX_ACCESS_TOKEN`; it skips only bearer verification. Exact Origin checks, duplicate-header rejection, schemas/JPEG/body/response limits, global quota/concurrency, timeout/abort cleanup, fixed provider policy, no-store and safe errors are unchanged.
- `GET /api/health` now returns exactly `{ready:boolean,authRequired:boolean}`. `authRequired:false` only for explicit demo, including unready demo. All other configurations return `authRequired:true`; no key/token/configuration value is exposed. Frontend peer owns auto-discovery/UI integration and its tests.
- This is public operator-funded paid API access. Origin is NOT authentication: any site visitor can incur spend, and non-browser clients can forge Origin. The unchanged global limits reduce resource exposure, not identity or total spending guarantees. Explicit image/text consent and USB chooser remain mandatory; token-free does not mean automatic capture/USB pairing or consent bypass. No frontend/device paths were edited.
- Demo launch, DOCUMENTATION ONLY, from `/home/minwoo/.superset/projects/videx/mobile` after key + allowed origins are already securely injected: `VIDEX_DEMO_MODE=true npm run server`. HOST/PORT defaults remain `127.0.0.1:8787`. Root equivalent: `VIDEX_DEMO_MODE=true node mobile/server/index.mjs`. No access-token setup is needed. To restore authentication, unset the flag or set `false`, securely configure a valid token and restart; token rotation alone does not restrict active demo access. This worker did not launch/configure any runtime demo.
- Changed this task only: `mobile/server/server.mjs`; new `mobile/server/demo.test.mjs`; existing health assertions in `mobile/server/server.test.mjs` and `mobile/server/startup.test.mjs`; `docs/v2/server-api.md`; this handoff. No package/config/frontend/peer-file edits.
- TDD RED: after writing anonymous Vision/speech + exact health-contract expectations, `node --test mobile/server/*.test.mjs` failed because demo without token was unready and health lacked `authRequired`. Minimal config/bearer/health implementation made the slice GREEN. Added preserved-behavior tests for missing/null/bad origins, required demo key/origins, ignored unused demo token, default/non-exact flags retaining 401 (or 503 without configured token), and global anonymous quota across both routes; no further production changes were needed.
- Final root command `node --test mobile/server/*.test.mjs`: PASS tests 25, pass 25, fail/cancelled/skipped/todo 0; duration 927.798554 ms.
- Final mobile command `npm run test:server` (executes `node --test server/*.test.mjs`): PASS tests 25, pass 25, fail/cancelled/skipped/todo 0; duration 735.738344 ms. Same suite, not separate unique tests. Existing slow-upload reader cleanup regression remains green.
- `for file in mobile/server/*.mjs; do node --check "$file" || exit; done && git diff --check`: PASS exit 0, no diagnostics. No dependency install/build/Vite server, persistent runtime change, secret read/write/provisioning, real key test/output, paid call, commit/push/flash/deploy. Startup/HTTP tests remain isolated random-port processes with explicit synthetic test environments/injected upstreams.
- Remaining handoff: frontend peer's no-token health discovery/UI integration and coordinator final union review. Browser/device/live provider/deployment are not claimed verified by this task. Backend code and docs are FROZEN.

SUPERSET_WORKER_DONE task: demo-backend summary: explicit opt-in anonymous demo and two-boolean health implemented;default auth preserved;frozen files: mobile/server/server.mjs;mobile/server/demo.test.mjs;mobile/server/server.test.mjs;mobile/server/startup.test.mjs;docs/v2/server-api.md;docs/v2/server-api-backend-handoff.md checks: TDD RED-GREEN;root25/25;mobile25/25;all mjs syntax;git diff --check handoff: frontend health discovery and parent union;Origin not auth/public spend documented;no runtime/secret setup
