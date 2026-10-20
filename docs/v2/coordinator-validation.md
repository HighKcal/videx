# Coordinator independent validation

Status: SOFTWARE UNION VERIFIED; physical/deployment acceptance remains blocked. This is execution evidence, not a claim that all release gates passed. No hardware and no paid OpenAI calls were used. Implementation workspace: `/home/minwoo/.superset/projects/videx`, branch `main`. Preserved baseline branch `v0.0.0` and unchanged original coordinator worktree HEAD: `f7f0ea496dc4a06bf15a98eee14e08dea186f071`. No commits or pushes.

## Completed independent checks

### Legacy Python paths
Isolated interpreter: `/home/minwoo/.hermes/profiles/dev-lead/cache/scratch/videx-regression-venv/bin/python`. Installed desktop manifest dependencies plus Pillow, pytest, scipy only in this scratch venv (no global/project manifest change).

Command from implementation root:

    <python> -m pytest -q --tb=short proxy/test_runtime.py proxy/test_desktop.py proxy/test_flood_fill_api.py proxy/test_flood_fill_mvp.py app/tests app/text_recognition/tests

Result: exit 0; 145 passed, 61 subtests passed.

Command:

    <python> -m pytest -q --tb=short app/stereo/tests

Result after installing its declared scipy requirement: exit 1; 32 passed, 4 subtests passed, 5 failed. All failures are `app/stereo/tests/test_capture.py` using the old Frame constructor, missing button_classified, button_result, jpeg arguments. Independently re-ran `app/stereo/tests/test_capture.py` in clean original worktree at the preserved baseline commit: exit 1, same 5 failures and 1 pass. These are pre-existing research-path failures, not new v2 regressions. Stereo is explicitly outside the single-camera mobile runtime; no unrelated fixes were made.

### S3 host-side C/Python core

    python proxy/tests_v2/run_host_tests.py --sanitize

Result: exit 0. Three C binaries built with `-std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined` and executed successfully: elapsed-time button/debounce/reconnect/stale input, CAM2/VDX2/JPEG dimensions/authentication/resolution/control queues, fail-closed provisioning/origin/local-network checks. Two provisioning Python tests passed. This does not exercise ESP32 hardware or TLS/Wi-Fi runtime.

### Vision / actual WebAssembly
From mobile:

    npm test -- tests/vision-wasm.test.ts tests/vision-detector.test.ts
    sha256sum src/vision/flood_fill.wasm
    rustfmt --edition 2021 --check src/vision/flood_fill.rs

All exit 0. Two suites, 10 tests passed, including actual WebAssembly instantiation/execution and JS comparison/fallback. Artifact SHA-256: `12fec71860403e0cbbb44222377249ac6cfefe99ab912ab731d1fdbe1666aecf`. This validates the flood-fill kernel, not exact OpenCV pixel parity or physical obstacle safety.

### UI visual review
Opened designer's actual browser screenshot `/home/minwoo/.hermes/profiles/coop-design/cache/scratch/videx-ui-mobile.png`: left VIDEX logo, single purple circle with two white bar eyes (captured mid-blink), gray caption box, no overlapping UI. Designer's detailed browser checks are separately self-reported in `ui-handoff.md`; final integrated browser verification is recorded below.

## Final union checks after worker freeze

The coordinator independently executed the final mobile command chain, exit 0:

    npm run format:check && npm test && npm run build && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/google/chrome/chrome npm run test:e2e && npm audit --audit-level=high

Results: formatting passed; 12 unit suites / 31 tests passed; strict TypeScript and Vite production build passed; 4 production Playwright tests passed with Chromium sandbox enabled; audit found 0 vulnerabilities. Browser tests exercised consent/withdrawal and late results, paired mock S3 and button OCR/front-back flow with simultaneous actual WASM Worker, exact CSP and static-only offline cache, and actual HTMLAudio playback/ended/URL revocation using a mocked WAV response. External API mocks do not establish real OpenAI service access or voice quality.

With the ESP-IDF environment from `firmware-handoff.md` activated, the coordinator independently reran `python3 proxy/tests_v2/run_host_tests.py --sanitize`: 7 C executables and 9 Python tests passed, skip 0, including actual cJSON and NVS generation. This supersedes the earlier partial host run above.

The coordinator then independently reran both exact IDF build commands documented in `firmware-handoff.md` against the final S3 source and CAM scratch snapshot. Both incremental builds completed successfully. S3 app partition has 41% free; CAM app partition has 10% free. Independent SHA-256 comparison of CAM `main` and `managed_components` against that snapshot: 168 files, 0 mismatches. Vendored git diff empty. Original linked worktree remains clean. `main` and `v0.0.0` still resolve to the preserved baseline SHA; implementation is uncommitted. Final tracked `git diff --check` passed.

## Remaining acceptance gates

- Actual flashing, boot, GPIO, camera, WSS/TLS, certificate trust, Android/iOS audio/network lifecycle, sustained performance and physical obstacle safety: not run (no hardware).
- Actual paid OpenAI requests, account permissions/CORS and natural voice quality: not run; tests use mocks.
- Public multi-user authentication and suitable short-lived Responses/TTS credential issuance: not implemented. Current private BYOK session-memory mode is not a public-service credential architecture.
- Existing stereo research-path failures remain as documented above. They were reproduced at baseline and were not silently repaired.
