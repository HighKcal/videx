# VIDEX v2

Prototype assistive phone PWA for camera glasses: classic ESP32-CAM (one camera) → ESP32-S3 → paired phone over local authenticated WSS. Phone-side walking-obstacle analysis is continuous; OCR and product recognition are user-requested. Obstacle output is not distance or a safety guarantee.

## Start and configure

- Quick entry: root [`README.md`](../../README.md). Existing Python desktop app instructions remain in [`README-DESKTOP.md`](../../README-DESKTOP.md); this v2 app is under `mobile/`.
- Run UI development server in a provisioned Node environment: `cd mobile && npm run dev`. UI dev does not provision the device.
- Configure exact DNS hostname at `mobile/deployment.config.json` (current `videx.local`), matching the device's valid TLS cert, Origin/Host allowlist and phone pairing. Stream only via `wss://<host>/ws`; the AI backend does not relay continuous video.
- Firmware build from root with activated compatible ESP-IDF: `idf.py -C cam build`, `idf.py -C proxy build`. Provision per device offline; details in [`firmware.md`](firmware.md). Verify actual partition table before NVS flashing and keep all generated credentials outside git.
- Current default AI mode sends only the user-selected still photo or recognized/screen text to the operator's own backend, which calls fixed OpenAI Vision/TTS endpoints. Continuous camera frames and walking analysis remain local; USB/local vision operation is not relayed. Separate consent is required for selected photo and text; speech receives text only. The backend's `VIDEX_ACCESS_TOKEN` is distinct from server-only `OPENAI_API_KEY`; neither belongs in frontend build configuration. A personal/shared bearer token is a service gate, not full public multi-user authentication. Keep deployment limited to a trusted environment unless a reviewed user identity/authorization and abuse-control layer exists. Direct OpenAI BYOK is an advanced opt-in mode. See backend-owned [`server-api.md`](server-api.md) for server setup and API details. Historical direct-only/BYOK statements below and in frozen handoffs describe the earlier implementation snapshot, not current default guidance.

## Implementation, tests, and hardware status

- Mobile/core union tests and strict production build passed as reported: `format:check` 0, `npm test` 12 suites/31 tests, `build` 0, sandbox Playwright 4 pass, audit 0 vulnerabilities. Details in [`mobile-handoff.md`](mobile-handoff.md) and coordinator-owned [`coordinator-validation.md`](coordinator-validation.md).
- Firmware handoff reports sanitized host C/Python (7 C executables, 9 Python, skip 0), S3 original build and CAM scratch-snapshot build pass. See [`firmware-handoff.md`](firmware-handoff.md).
- Vision: 10 targeted tests pass; WASM artifact hash and limitations in [`vision-handoff.md`](vision-handoff.md). UI scoped checks in [`ui-handoff.md`](ui-handoff.md).
- Independent legacy regression passed 145 tests/61 subtests. Stereo tests have five constructor failures reproduced on clean baseline; tracked as pre-existing. See [`requirements.md`](requirements.md) and [`validation.md`](validation.md).
- Physical board, trusted deployed WSS/public authentication, Android/iOS local-network/lifecycle/accessibility, live OpenAI and field performance remain hardware/release gates. Nothing here claims those are accepted.

## Documents

- [Requirements traceability](requirements.md)
- [Validation and deployment procedure](validation.md)
- [Specification notes and remaining gates](spec-notes.md)
- [Firmware implementation/provisioning](firmware.md)
- [Mobile/core implementation handoff](mobile-handoff.md)
- [UI handoff](ui-handoff.md)
- [Vision handoff](vision-handoff.md)
- [Coordinator independent validation](coordinator-validation.md) (team lead owned; read-only here)
