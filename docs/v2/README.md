# VIDEX v2

Current target: prototype Android assistive app connected to the board through USB CDC, with physical buttons for controls. No WSS transport and no browser OpenAI key/server-token UI. Any selected photo/text sent for AI processing uses the same-origin Node server; continuous capture remains on the CDC/local path. This is not safety-certified and does not promise distance, clear path, or background monitoring. Earlier WSS/BYOK material below is historical unless explicitly marked current.

## Start and configure

- Quick entry: root [`README.md`](../../README.md). Existing Python desktop app instructions remain in [`README-DESKTOP.md`](../../README-DESKTOP.md); this v2 app is under `mobile/`.
- Run UI development server in a provisioned Node environment: `cd mobile && npm run dev`. UI dev does not provision the device.
- Follow [`android-usb-cdc.md`](android-usb-cdc.md) for current Android USB chooser guidance, noting that this document contains pre-migration details and must be checked against the frozen CDC protocol contract. Do not follow the historical WSS setup below for this target.
- Firmware build from root with activated compatible ESP-IDF: `idf.py -C cam build`, `idf.py -C proxy build`. Provision per device offline; details in [`firmware.md`](firmware.md). Verify actual partition table before NVS flashing and keep all generated credentials outside git.
- AI transport is same-origin server-only: browser UI has no API key or access-token fields. Operator injects `OPENAI_API_KEY`, exact allowed origins and, for a deliberately anonymous demo, `VIDEX_DEMO_MODE=true` into the Node process. Demo access is anonymous and operator-funded; Origin and quotas are not user authentication or a guarantee against spend abuse. Keep exposure controlled and apply provider spending controls. See [`server-api.md`](server-api.md). Separately consented selected photos/text only may be relayed; no continuous frames. CDC protocol details are owned by firmware and will be specified in `cdc-protocol.md`; do not infer exact wire/control semantics from legacy docs.

## Historical pre-CDC implementation, tests, and hardware snapshot

- Mobile/core union tests and strict production build passed as reported: `format:check` 0, `npm test` 12 suites/31 tests, `build` 0, sandbox Playwright 4 pass, audit 0 vulnerabilities. Details in [`mobile-handoff.md`](mobile-handoff.md) and coordinator-owned [`coordinator-validation.md`](coordinator-validation.md).
- Firmware handoff reports sanitized host C/Python (7 C executables, 9 Python, skip 0), S3 original build and CAM scratch-snapshot build pass. See [`firmware-handoff.md`](firmware-handoff.md).
- Vision: 10 targeted tests pass; WASM artifact hash and limitations in [`vision-handoff.md`](vision-handoff.md). UI scoped checks in [`ui-handoff.md`](ui-handoff.md).
- Independent legacy regression passed 145 tests/61 subtests. Stereo tests have five constructor failures reproduced on clean baseline; tracked as pre-existing. See [`requirements.md`](requirements.md) and [`validation.md`](validation.md).
- Physical board, trusted deployed WSS/public authentication, Android/iOS local-network/lifecycle/accessibility, live OpenAI and field performance remain hardware/release gates. Nothing here claims those are accepted.

## Documents

- [Server setup and API security limits](server-api.md)
- [CDC-only migration validation](cdc-only-validation.md)
- [Firmware-owned CDC contract](cdc-protocol.md) (implementation status and protocol details are maintained by firmware owner)

- [Requirements traceability](requirements.md)
- [Validation and deployment procedure](validation.md)
- [Specification notes and remaining gates](spec-notes.md)
- [Firmware implementation/provisioning](firmware.md)
- [Mobile/core implementation handoff](mobile-handoff.md)
- [UI handoff](ui-handoff.md)
- [Vision handoff](vision-handoff.md)
- [Coordinator independent validation](coordinator-validation.md) (team lead owned; read-only here)
