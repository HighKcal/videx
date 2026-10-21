# CDC-only migration validation handoff

Scope: server security-header/CSP alignment and current-flow documentation only. Repository: `/home/minwoo/.superset/projects/videx`, branch `feat/videx-v2-android-cdc-demo`. This handoff does not define the CDC wire protocol; firmware owner owns [`cdc-protocol.md`](cdc-protocol.md). That contract appeared during this task and identifies itself as frontend implementation/verification pending; this handoff makes no claims of completed protocol integration.

## Current alignment

- Node serves the built UI and same-origin API. CSP `connect-src` is now exactly `'self'`; it no longer grants direct OpenAI network access or WSS/device-host access, and server construction no longer reads `mobile/deployment.config.json`.
- Retained existing same-origin script/WASM, inline-style, blob/data image/media, worker, framing/object restrictions and security headers.
- Preserved existing server authentication/demo environment modes, exact Origin guard and bounded anonymous-demo quotas. No new auth system was added. For intended token-free demo, operator uses `VIDEX_DEMO_MODE=true` and owns provider billing/abuse exposure; Origin and quotas are not visitor authentication.
- Root and v2 guides now describe Android USB CDC/physical-button current target, no WSS and no browser API-key/server-token UI. Legacy WSS/BYOK content is explicitly historical. CDC-specific wire/control claims are deferred to firmware-owned protocol docs.

## Tests actually run in this task

RED, after changing the existing static-header assertion first:

`node --test --test-name-pattern='same port serves built assets' mobile/server/static.test.mjs`

Observed expected failure: assertion that external CSP allowance was absent failed (`true !== false`) against the old OpenAI/WSS `connect-src` policy.

GREEN/full backend suite, from repository root:

`node --test mobile/server/*.test.mjs`

Observed: 25 tests, 25 pass, 0 fail, 0 cancelled, 0 skipped. Includes demo mode, authenticated mode, static serving/CSP, and the upload-timeout regression (`408`, `Connection: close`, socket destroyed, pending reader 0, 10 consumed bytes vs 4096 attempted late bytes, concurrency `429` before / `200` after). Tests use isolated random ports/injected upstreams; no paid API calls. The already-running localhost:8787 service was not restarted, stopped, or inspected for secrets.

No build, install, mobile UI tests, browser E2E, hardware/Android run, API call, deployment, push or commit was performed in this task.

## Remaining gates

- Coordinator-reported unit/build/server/format/browser integration and host firmware tests are now recorded below. This author did not rerun those suites.
- Actual Android/USB hardware, real physical-button operation, and physical S3 flash/boot remain unverified.
- Static cross-language CDC review is recorded below; exact physical firmware/browser compatibility still requires device validation.
- The live server's current runtime configuration is outside this review; documentation does not imply a restart or configuration change.

## Completion

Owned changes: `mobile/server/server.mjs`, `mobile/server/static.test.mjs`, `README.md`, `docs/v2/README.md`, `docs/v2/mobile.md`, `docs/v2/server-api.md`, and this handoff. No files under `mobile/tests/` or firmware sources were edited. Work is frozen for coordinator integration.

## Read-only CDC contract/source cross-review

Reviewed firmware-owned [`cdc-protocol.md`](cdc-protocol.md), current proxy implementation (`proxy/main/cdc_core.h`, `gateway.c`, `gateway_json.h`), CAM implementation (`cam/main/main.c`, `cam/main/cam_core.c`), and mobile implementation/tests (`mobile/src/core/usb-wire.ts`, `usb-source.ts`, `controller.ts`, `mobile/tests/usb-wire.test.ts`, `usb-source.test.ts`). No source or tests were changed and no builds/tests were run for this review.

Static alignment observed:

- Negotiation: firmware starts with CAM2 and emits USB2 only after a kind=1 `hello` at epoch 0 (`cdc-protocol.md:7,24`; `cdc_core.h:20-45,68-73`; `gateway.c:244-263`). Mobile sends hello after opening CDC, accepts frames concurrently, waits 1500 ms, and falls back to legacy only while still in `hello` (`usb-source.ts:78-110`). Firmware serializes complete USB2 controls and CAM2 records with control priority before a pending frame (`gateway.c:304-334`). The documented initial negotiation window and source behavior align; no concrete mismatch found.
- Partial-record behavior: protocol's 500 ms USB2 partial timeout terminates the active session. Firmware resets its RX parser and fails an active session on bad/timeout records (`cdc_core.h:20-45`; `gateway.c:277-287`); mobile parser throws on malformed/expired USB2 and its source closes/fails rather than continuing the negotiated session (`usb-wire.ts:99-109`; `usb-source.ts:88-96,120-138`). CAM2 parse recovery is distinct: mobile byte-resynchronizes invalid/expired CAM2 candidates (`usb-wire.ts:111-179`). No contradictory resync expectation found.
- Epoch and button dedupe: firmware allocates a nonzero session epoch, resets event sequence at session start, and emits increasing event IDs (`cdc_core.h:68-81`). Mobile requires connected response header/JSON epochs to match, requires all later controls to use the current session epoch, and drops duplicate/older button event IDs (`usb-source.ts:225-253`). Consistent with the contract.
- Control-only events: firmware's BTN2 receiver queues events independently of camera frames, and USB sender drains queued controls even when no latest frame exists (`gateway.c:212-239,309-334`; `cdc_core.h:75-81`). Mobile routes USB2 records to control handling independently of CAM2 frame callbacks (`usb-wire.ts:63-109`; `usb-source.ts:120-138,225-253`). Existing USB source test sends button controls before its subsequent CAM2 packets (`mobile/tests/usb-source.test.ts:153-164`).
- Old CAM/raw fallback: protocol limits raw mode bytes and frame-flag classification to the legacy state and to boards that actually provide usable flags (`cdc-protocol.md:35,39`). Mobile sends raw mode only after the hello deadline and classifies CAM2 button flags only in `legacy`, never in `cdc2` (`usb-source.ts:81-87,156-165,218-224`). `Cam2Buttons` supports observed raw press/valid flags and classified result flags (`usb-wire.ts:12-49`); current CAM emits raw validity/pressed bits (`cam/main/main.c:210-215`). No static cross-language mismatch found. Compatibility with each previously installed CAM/S3 firmware variant remains hardware/fixture validation, not proven by these source reads.

No concrete cross-language blocker identified in the reviewed paths. The firmware contract itself labels frontend implementation/verification pending (`cdc-protocol.md:1,41-43`); source presence and unit tests are not a claim of integrated firmware/browser/physical-device completion. In particular, old-board legacy button behavior and late/partial records on real USB hardware remain pending coordinator/owner validation. No exact protocol expansion is proposed here.

## Final frozen-source validation (coordinator-reported)

These results were supplied by the parent/coordinator for the frozen source snapshot; this documentation-only reconciliation did not rerun them:

- Mobile from `/home/minwoo/.superset/projects/videx/mobile`: unit 105/105, build/typecheck passed, server 25/25, format check passed, full E2E 14/14, diff-check passed.
- Host firmware tests: 9 C sanitizer (ASan/UBSan) suites passed; Python 7 tests with 1 NVS skip, plus 4 additional Python tests passed.
- Firmware build/source evidence: coordinator reports the built firmware source snapshot equals the current source; IDF build itself was executed by the worker. Binary size 787,296 bytes; SHA-256 `a17ef1e8c47a43c3a8ca4333838ae373a4874a82bae32096cad1db673bb7313c` verified.
- Real-browser smoke at `https://vt.ssammwu.info/?v=cdc-only`: loaded script `index-BQito510.js`; password inputs 0, WSS/BYOK option absent, USB connect button present. `/api/health` returned `ready:true, authRequired:false`; demo UI state observed. This is coordinator-reported browser observation, not a paid provider call or physical device test.

### Outstanding deployment and hardware limits

- No paid OpenAI API call was made.
- No physical Android CDC connection, camera/button operation, or S3 firmware flash was performed.
- The already-running Node service was not restarted. Its live response CSP header remains from the old process and is broader; the new built HTML's meta CSP restricts browser behavior by policy intersection. The changed server-source CSP (`connect-src 'self'`) takes effect only after an operator-controlled service restart. Do not claim the running process has the new header policy until restarted and rechecked.
- Runtime credentials, live provider permissions/billing, production tunnel/proxy deployment and physical release acceptance remain operator/release gates.
