# VIDEX v2 same-origin server API

## Runtime and ownership

The dependency-free Node ESM server is `mobile/server/index.mjs`. It serves the existing `mobile/dist` build and the API on one port; there is no separate production frontend origin and no OpenAI credential in the build. Use Node 22.12+ (verified here with Node v26.10.0). No package installation is needed for this server. The frontend owner builds `mobile/dist`; the server does not run Vite, build assets, read `.env`, or install dependencies.

Default client mode is the same-origin server transport, with bearer authentication required unless the operator explicitly enables public demo mode below. Advanced direct BYOK is a separate frontend compatibility option, not an automatic fallback. Only separately consented, explicitly selected JPEGs and speech text may be sent. Continuous walking frames remain local. The server cannot prove user consent or selection provenance; the frontend must preserve those gates and cancellation semantics. Demo mode removes only the server access-token requirement: user image/speech consent and the explicit USB device chooser remain required; visiting the site does not automatically select a USB device or authorize content transmission.

## Configuration and startup

Inject these variables into the Node service process through the operator's trusted environment/secret manager. Never use frontend `VITE_*` variables, browser storage, source files, URLs, or static build artifacts for credentials. The server does not load secret files.

| Variable | Required / meaning |
| --- | --- |
| `OPENAI_API_KEY` | Required server-only OpenAI credential; no whitespace/control characters. Never enter it as the application's server access token. |
| `VIDEX_ACCESS_TOKEN` | Required in default authenticated mode: distinct, cryptographically random server bearer token, 32–512 visible ASCII characters without whitespace. Generate/store/distribute it out of band through an approved secret manager. It must differ from the provider key. Not required or validated in explicit demo mode. |
| `VIDEX_DEMO_MODE` | Opt-in public demo only. Exactly the string `true` disables bearer authentication; unset, `false`, uppercase variants, whitespace, `1` and all other values retain default authentication. Never read from a request, URL or browser-controlled setting. |
| `VIDEX_ALLOWED_ORIGINS` | Required comma-separated exact canonical HTTPS origins. No wildcard, credentials, path, trailing slash, query, fragment, or suffix matching. Whitespace around comma-separated entries is trimmed. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development origins, with the exact port. |
| `HOST` | Optional; defaults to `127.0.0.1`. Explicit wider binding is an operator decision, not the default. |
| `PORT` | Optional; defaults to `8787`. Decimal port; `0` requests an ephemeral port for tests. |

Commands below are authenticated-mode documentation templates, not commands executed with real credentials. Leave `VIDEX_DEMO_MODE` unset or set it to `false` for these commands. Replace placeholders via the trusted service environment; avoid putting real keys in shell history or process arguments.

From `/home/minwoo/.superset/projects/videx`:

```sh
env OPENAI_API_KEY='<SERVER_ONLY_OPENAI_KEY>' \
    VIDEX_ACCESS_TOKEN='<DISTINCT_RANDOM_SERVER_ACCESS_TOKEN_MINIMUM_32_CHARACTERS>' \
    VIDEX_ALLOWED_ORIGINS='https://<PUBLIC_APP_HOST>' \
    HOST='127.0.0.1' PORT='8787' \
    node mobile/server/index.mjs
```

From `/home/minwoo/.superset/projects/videx/mobile`, use the same variables and port:

```sh
env OPENAI_API_KEY='<SERVER_ONLY_OPENAI_KEY>' \
    VIDEX_ACCESS_TOKEN='<DISTINCT_RANDOM_SERVER_ACCESS_TOKEN_MINIMUM_32_CHARACTERS>' \
    VIDEX_ALLOWED_ORIGINS='https://<PUBLIC_APP_HOST>' \
    HOST='127.0.0.1' PORT='8787' \
    node server/index.mjs
```

When these variables have already been securely injected, the exact commands are simply `node mobile/server/index.mjs` from the root or `node server/index.mjs` from `mobile`. Development operators may set `VIDEX_ALLOWED_ORIGINS=http://localhost:5173` (or the exact actual browser origin); the frontend's Vite `/api` proxy targets `http://127.0.0.1:8787`. Do not start another Vite dev server sharing `node_modules/.vite` with a live server.

Missing/invalid API configuration is a deliberate degraded startup: stderr names only invalid variable NAMES, static serving remains available, health says `ready:false`, and paid routes return 503 without any upstream call. Invalid bind/public device configuration fails startup with a generic diagnostic and exit code 1. Restart after updating configuration: it is read once at startup. Readiness validates configuration presence/shape only; it does not verify key validity, provider access, billing, or dist freshness.

### Explicit public demo — token-free visitors, operator-funded calls

After `OPENAI_API_KEY` and `VIDEX_ALLOWED_ORIGINS` are already securely injected into the service environment, the demo launch command from `/home/minwoo/.superset/projects/videx/mobile` is:

```sh
VIDEX_DEMO_MODE=true npm run server
```

This command is documented only; this worker has not started or configured a runtime demo. HOST/PORT remain `127.0.0.1:8787` unless explicitly configured. From the repository root the equivalent entry is `VIDEX_DEMO_MODE=true node mobile/server/index.mjs`. No `VIDEX_ACCESS_TOKEN` is needed; an existing token does not restrict demo access. `OPENAI_API_KEY` and the exact origin allowlist remain required, so demo health may be `{ready:false,authRequired:false}` and paid requests then fail 503 without any provider call.

This is deliberately anonymous public paid access, NOT authentication via Origin. Any visitor to the public site can consume operator-funded OpenAI calls, and non-browser clients can forge Origin. The Origin check is a browser-origin guard, not caller identity, authorization, secrecy, or spending protection. Existing size, shared global rate/concurrency, timeout, abort, fixed-provider and no-store protections remain unchanged, but do not eliminate spend or abuse risk. Use provider project spending limits and a deliberately limited demo exposure; do not describe it as protected by the allowlist. Consent and USB selection remain explicit. To restore access control, unset the demo flag or set it to `false`, securely configure `VIDEX_ACCESS_TOKEN`, and restart; rotating a token alone does not restrict an active demo.

## HTTP contract

All API success/errors have `Cache-Control: no-store`. Errors are JSON `{ "error": "<generic safe message>" }`, with no provider diagnostics or request contents. No cookies or user-supplied provider headers are forwarded.

- `GET /api/health`: public 200 `{ "ready": true|false, "authRequired": true|false }`, with exactly these two booleans and no key/token/configuration values. `authRequired:false` occurs only for explicit `VIDEX_DEMO_MODE=true`, independently of readiness; it is true otherwise. Other methods are rejected.
- `POST /api/vision`: `Content-Type: application/json`, exact allowlisted `Origin`, and `Authorization: Bearer <SERVER_ACCESS_TOKEN>` in authenticated mode; no bearer required in explicit demo mode. JSON must contain exactly `{ "image": "data:image/jpeg;base64,<JPEG_BASE64>", "kind": "ocr" | "object" }`. Success: 200 `{ "text": "..." }`, at most 4000 UTF-16 code units.
- `POST /api/speech`: same headers/authentication. JSON must contain exactly `{ "text": "..." }`. Nonempty/non-whitespace string of at most 4000 UTF-16 code units. Success: 200 `Content-Type: audio/mpeg`, binary MP3 bytes.

In authenticated mode, `<SERVER_ACCESS_TOKEN>` means the value of the server's `VIDEX_ACCESS_TOKEN`, NOT an OpenAI key and NOT another environment variable. The browser keeps this token in memory only and sends it in the Authorization header, never a URL. A shared token is a limited trusted-user access gate, not login, per-user identity, a token issuer, or a multi-tenant authorization system. Demo mode skips bearer verification only; it does not accept a client OpenAI key or change server-side provider credential forwarding.

When authentication is required, bearer verification compares fixed-length SHA-256 digests with `timingSafeEqual`. In both modes, Origin is matched literally against the configured set; missing Origin, `Origin:null`, other schemes/ports, lookalikes and untrusted forwarding headers fail that guard. Origin is not authentication and can be forged outside browsers. No wildcard/reflected CORS headers or cross-origin preflight grants are emitted. `OPTIONS` is rejected. Duplicate authentication/origin/content headers are rejected.

The frontend must use a server-mode fetch/referrer policy that preserves the browser's normal same-origin Origin. A `no-referrer` request policy can produce `Origin:null` in some browser flows; fix the client policy rather than allowing null. The response `Referrer-Policy: no-referrer` is retained for privacy; integration must exercise the real browser request, not only a mocked route.

Common statuses: 400 invalid JSON/schema/JPEG, 401 unauthorized, 403 disallowed/missing/null Origin, 404 unknown GET path, 405 unsupported method, 408 upload deadline, 413 body too large, 415 media type/encoding unsupported, 417 unsupported Expect, 429 global quota/concurrency (`Retry-After`), 431 oversized HTTP headers, 502 generic upstream failure, 503 unconfigured, 504 upstream deadline. Invalid wire-level requests are also closed with safe no-store JSON where an HTTP response can be sent; disconnected sockets cannot receive an error response.

## Fixed provider policy and bounded resources

The only upstream base is `https://api.openai.com/v1/`. The server never accepts caller-selected models, URLs, prompts, voices, instructions, or headers.

- Vision: `/responses`, `gpt-4.1-mini`, `store:false`, `max_output_tokens:800`, image detail high, with the existing Korean OCR/object prompts copied from the original client. User document instructions are not trusted by the fixed OCR prompt. `store:false` does not promise provider zero-data-retention.
- Speech: `/audio/speech`, `gpt-4o-mini-tts`, `coral`, `response_format:mp3`, fixed clear/natural Korean speech instruction. Only the submitted bounded text is sent.
- Upstream requests use POST, `redirect:error`, `credentials:omit`, `cache:no-store` and an AbortSignal. Only the server-only provider credential and JSON Content-Type are supplied. No retries or redirect followups.
- Vision JSON body: at most 8,000,128 bytes, including for chunked transfer. JPEG data URL: at most 8,000,000 characters, canonical base64. Structural JPEG marker/segment/frame/scan checks require a complete bounded 8-bit Huffman JPEG, with no trailing bytes. Maximum dimension 8192, maximum 32,000,000 pixels. This is structural validation, not a full entropy decoder; unsupported JPEG types fail closed.
- Speech JSON body: at most 16,384 bytes; text limit above is independently checked. Invalid UTF-8, extra/missing properties, arrays/null and encoded/compressed request bodies are rejected.
- Upstream response: at most 262,144 decoded body bytes for vision JSON, 10,000,000 for speech. Advertised oversize and streamed oversize are both rejected/cancelled. Empty or wrong-content-type responses and malformed/empty vision output are generic failures. Responses are buffered within those ceilings before success headers, preventing partial provider failures from appearing as success.
- One process-wide fixed-window quota: 30 allowed-origin attempts passing the current mode's auth gate per 60 seconds across both paid routes, including schema failures and anonymous demo requests. No per-IP maps or forwarding-header trust. One global concurrent limit: 2 upload/upstream/audio-delivery operations, with immediate 429 and no waiting queue. Concurrency rejection does not consume a new quota slot.
- Upload deadline 10 seconds; upstream deadline 12 seconds includes response body reading. On upload timeout, the safe 408 is flushed (or the response closes), then the request stream is explicitly destroyed and its body-reader promise is awaited before releasing concurrency. Connection:close alone is not treated as reader cancellation. Client disconnect aborts upstream work. Slow audio delivery keeps its concurrency slot until finish/disconnect, with a 5-second delivery deadline. Byte-limit exits cancel the upstream response stream.
- HTTP header ceiling 8192 bytes; header timeout 10 seconds; request timeout and socket inactivity timeout 15 seconds; keepalive 5 seconds; 64 connections and 100 requests per socket. Constructor overrides are an internal test seam, reject invalid/unbounded values, and are not accepted from HTTP or environment configuration. CLI/env cannot disable or alter the defaults.

Quota/counters are in-memory, process-local and reset at restart. Do not multiply worker replicas without a shared reviewed quota boundary; provider project-level spending limits remain necessary. These controls bound this service, not all denial-of-service or spend risk. A shared token holder can exhaust the shared quota. No key, bearer, image, text, audio or raw provider error is logged or persisted by this implementation; operational logging must preserve that property.

## Production static serving and reverse proxy

Terminate HTTPS at a trusted reverse proxy in front of the loopback Node port and expose the frontend and `/api/*` under the SAME public origin. Preserve Authorization and the browser Origin exactly; do not rewrite a missing/null Origin into an allowed one. Forwarding headers are not authentication inputs. Configure ingress request/connection limits and disable request/response body logging, credential logging, API caches, CDN caching and redirects. Do not redirect paid POSTs or forward credentials to another host.

Node serves only root `index.html`, `sw.js`, `icon.svg`, `manifest.webmanifest` and approved asset extensions beneath `dist/assets/`. It does not serve source, server files, arbitrary config, dotfiles, `_headers`, captures, directories or SPA API fallbacks. Traversal/percent-encoded paths, symlinked roots/ancestors/targets, and non-regular/oversized files are rejected. Open uses `O_NOFOLLOW`, plus realpath and descriptor identity checks. Deploy immutable, operator-owned, non-symlink build files; this is not a sandbox against a hostile local writer with build-directory access.

The server sets CSP and security headers itself: `_headers` is NOT automatically applied. CSP permits the current same-origin JS/WASM/workers, React inline styles, blob media and data/blob images; network connections are self, the separate direct BYOK OpenAI origin, and the exact WSS host from public `mobile/deployment.config.json`. It also denies framing/objects and sets nosniff, no-referrer and restrictive Permissions-Policy. Keep that public device host consistent with the frontend build.

All static HTTP responses, including `sw.js`, are conservatively no-store. The existing frontend service worker intentionally caches only enumerated public build assets; it must never cache API, selected image, text or audio data. HTTP no-store alone cannot override a misbehaving service worker, so the frontend's static-only worker contract remains required.

Rotation/revocation: replace the server bearer via the trusted service environment and restart; re-enter the new bearer in trusted client memory. Existing new requests using the old token fail; terminate/restart the process to stop in-flight operations as well. Rotate the server OpenAI credential independently through the provider and trusted service environment. Never put either value in this document or support logs. The worker has not provisioned any runtime credential, started a persistent service, configured TLS, or deployed anything.

## Tests

From the repository root: `node --test mobile/server/*.test.mjs`.
From `mobile`: `node --test server/*.test.mjs`.

`createVidexServer({env, fetcher, distDir, limits, now})` is exported from `mobile/server/server.mjs`; listen on port 0 for isolated HTTP integration tests. Every test passes synthetic environment values explicitly and injected upstream responses; startup subprocesses use sanitized environments with no credentials. No test calls the paid provider. `startup.test.mjs` deliberately exercises the existing actual `mobile/dist` build from both working directories; have the frontend owner build it first if absent. Other static tests use temporary fixtures only under `mobile/server` and remove them.

Backend-specific command/results and release limitations are recorded in `server-api-backend-handoff.md`; coordinator's final integrated browser/build/test results and unexecuted gates are recorded in [`server-api-validation.md`](server-api-validation.md). The coordinator reports real Chrome server-mode Origin handling and injected-upstream OCR/MP3 playback passing in the integrated E2E suite. Production TLS/tunnel/proxy deployment, runtime secret registration, actual OpenAI permissions/output quality and real Android behavior remain unexecuted release gates; mocked upstream integration is not a live provider or deployed-service verification.
