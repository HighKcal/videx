# VIDEX v2

VIDEX v2 is a prototype assistive application for blind/low-vision users: one classic ESP32-CAM sends frames to an ESP32-S3; a paired phone PWA receives the local WSS stream for continuous walking-obstacle analysis and user-requested text/product recognition. This is not a safety-certified mobility aid; no distance estimate, clear-path guarantee, or background/screen-lock monitoring is promised.

## Start and configure

1. Use compatible Node.js/npm and ESP-IDF toolchains. Dependencies are prepared by the project owners; no installation is needed for this guide.
2. For mobile UI development: `cd mobile && npm run dev`. This serves the UI; it does not connect or provision a camera.
3. Set `deviceHost` in `mobile/deployment.config.json` to the exact device DNS hostname before building. Configure that same hostname in S3 certificate, allowed Origin and device pairing. Current value `videx.local` is a configuration value, not a guaranteed deployed host/certificate.
4. Follow [`docs/v2/firmware.md`](docs/v2/firmware.md) for unique per-device offline provisioning. Verify the actual partition table before writing NVS; never guess offsets or commit secret material.
5. With compatible ESP-IDF activated, firmware project build commands from the repository root are `idf.py -C cam build` and `idf.py -C proxy build`. For board flashing, use the selected target/port and actual partition layout. Cross-build success is not hardware acceptance.
6. Deliver the PWA from a browser-trusted HTTPS origin and connect only to `wss://<deviceHost>/ws`. No public service should relay video.
7. The current default AI transport is the operator's own backend. Configure its server-only `OPENAI_API_KEY`, a separate `VIDEX_ACCESS_TOKEN`, and exact `VIDEX_ALLOWED_ORIGINS`; see [`docs/v2/server-api.md`](docs/v2/server-api.md) (backend-owned) for setup and API details. The server token is not an OpenAI key. Separate consent gates sending only the selected still photo or recognized/screen text through that backend to OpenAI; TTS receives text only. USB operation and continuous walking analysis remain local; continuous video is not relayed. A personal/shared access token is not full public multi-user authentication: do not expose the service publicly without a reviewed user-authentication/authorization boundary, deployment controls and abuse protections. Direct OpenAI BYOK remains an explicit advanced option, not the default.

The existing Python desktop app is separate and remains documented in [`README-DESKTOP.md`](README-DESKTOP.md). See [`docs/v2/README.md`](docs/v2/README.md) for detailed setup, status and privacy limits.

## Frozen verification snapshot

Team lead independently ran union checks: mobile `format:check` exit 0; `npm test` 12 suites/31 tests pass; strict TypeScript + Vite build exit 0; production sandbox Playwright 4 pass; `npm audit` 0 vulnerabilities. Firmware sanitized host tests (7 C + 9 Python, skip 0), S3 original build and CAM scratch-snapshot build all pass per coordinator report and `firmware-handoff.md`. Vision targeted suite 10 tests pass with checked-in WASM SHA-256 recorded in its handoff. Legacy Python regression passes (145 tests, 61 subtests); separate stereo suite has five pre-existing failures reproduced on clean baseline. Exact evidence/status: [`docs/v2/validation.md`](docs/v2/validation.md), [`requirements`](docs/v2/requirements.md), [`coordinator-validation.md`](docs/v2/coordinator-validation.md).

Physical hardware, deployed trusted TLS/public authentication, mobile OS local networking/lifecycle, real-scene safety/performance, and live paid OpenAI behavior remain unverified gates. Automated tests and cross-builds do not imply device acceptance. No changes to `README-DESKTOP.md` were made.
