# VIDEX v2

VIDEX Android CDC demo is a prototype assistive app for blind/low-vision users. Current target uses Android USB CDC and physical buttons; it does not use WSS or present browser API-key/access-token UI. Keep camera data on the CDC/local path except for a separately user-consented selected photo sent through the same-origin server to OpenAI; any speech transfer is text-only and separately consented. The Node server holds provider configuration, not the browser. This is not a safety-certified mobility aid; no distance estimate, clear-path guarantee, or background/screen-lock monitoring is promised.

## Start and configure

1. Use the currently supported Android/USB-capable browser and connect the board through its CDC USB interface. Choose/connect the device explicitly and use physical buttons for capture/mode controls. Protocol-specific details will be maintained in [`docs/v2/cdc-protocol.md`](docs/v2/cdc-protocol.md) by the firmware owner; do not infer support from legacy WSS instructions.
2. For UI/server development, use the already provisioned Node environment and [`docs/v2/server-api.md`](docs/v2/server-api.md). The server serves the built UI and same-origin APIs; it does not provision or flash hardware.
3. The browser has no OpenAI key or server-token field. Operator-only credentials/configuration belong in the Node service environment. Explicit demo mode (`VIDEX_DEMO_MODE=true`) is anonymous operator-funded access; strict Origin checks and quotas do not authenticate visitors or prevent all spend abuse. Limit exposure and apply provider spending controls. Do not assume the token-protected default is enabled unless the operator confirms environment.
4. Use a separately consented, selected still photo for OCR/object analysis; continuous capture/frames stay on the CDC/local path. Any TTS sends text only after separate consent. No automatic fallback to direct browser OpenAI transport.
5. Follow [`docs/v2/firmware.md`](docs/v2/firmware.md) for offline provisioning. Verify the actual partition table before writing NVS; never guess offsets or commit secret material. Firmware build commands and flashing remain hardware-specific; cross-build success is not hardware acceptance.

The existing Python desktop app is separate and remains documented in [`README-DESKTOP.md`](README-DESKTOP.md). See [`docs/v2/README.md`](docs/v2/README.md) for detailed setup, status and privacy limits.

## Historical v2 verification snapshot (pre-CDC migration)

Team lead independently ran union checks: mobile `format:check` exit 0; `npm test` 12 suites/31 tests pass; strict TypeScript + Vite build exit 0; production sandbox Playwright 4 pass; `npm audit` 0 vulnerabilities. Firmware sanitized host tests (7 C + 9 Python, skip 0), S3 original build and CAM scratch-snapshot build all pass per coordinator report and `firmware-handoff.md`. Vision targeted suite 10 tests pass with checked-in WASM SHA-256 recorded in its handoff. Legacy Python regression passes (145 tests, 61 subtests); separate stereo suite has five pre-existing failures reproduced on clean baseline. Exact evidence/status: [`docs/v2/validation.md`](docs/v2/validation.md), [`requirements`](docs/v2/requirements.md), [`coordinator-validation.md`](docs/v2/coordinator-validation.md).

Physical hardware, deployed trusted TLS/public authentication, mobile OS local networking/lifecycle, real-scene safety/performance, and live paid OpenAI behavior remain unverified gates. Automated tests and cross-builds do not imply device acceptance. No changes to `README-DESKTOP.md` were made.
