# VIDEX v2 validation, operation, and deployment

Status vocabulary: **implemented** means source exists; **tested** means a named automated check/build ran and has recorded output; **hardware-gate** means physical boards, deployed trust, mobile OS, or live-service evidence is outstanding. Current code/host/mobile checks are frozen and pass as summarized below. This is not a claim of physical release acceptance.

## Start and configure the mobile app

Prerequisites: compatible Node.js/npm and dependency tree prepared by CORE. DOCS did not install dependencies or run builds/tests. From repository root:

    cd mobile
    npm run dev

This starts Vite's development UI; it does not provision a camera, TLS, pairing credentials or OpenAI access. Build/test commands in `mobile/package.json` are `npm run format:check`, `npm test`, `npm run build`, `npm run test:e2e`, `npm audit` and `npm run preview`. Final verified output below is from the team's independent union run, not this docs update.

The device host is read from `mobile/deployment.config.json` (currently `videx.local`), used for Vite CSP and diagnostics pairing. Set it to the exact DNS hostname before building. Provision the same hostname in the S3 certificate and exact Origin/Host policy. Resolve it on the private LAN to the S3 address while preserving normal certificate trust. Browser endpoint must be `wss://<deviceHost>/ws`. No `ws://`, self-signed/untrusted cert, public proxy, CDN or tunnel may relay frames.

## Private single-user OpenAI setup limitation

1. Diagnostics accepts a per-device pairing token and the user's own API key for the active session. Separate consents gate sending the selected image to Vision and text to TTS. Disconnect clears the app's in-memory key; this does not prevent browser JavaScript in that session from accessing it.
2. OpenAI Realtime ephemeral credentials are not a credential solution for Responses/TTS in this app. No ephemeral credential broker for these endpoints is implemented. Do not embed a long-lived key in a build, share a common key, log it, or expose an invented public token endpoint. This BYOK design is only suitable for a trusted private user session, not a public multi-user service. The user must rotate/revoke a key if exposed.
3. Only the selected still is sent directly to OpenAI Responses/Vision (`gpt-4.1-mini`, `store:false`). Product recognition captures front/back separately and sends a locally merged still. Speech text is sent directly to `/v1/audio/speech` using `gpt-4o-mini-tts`; TTS receives no image. Disclose transfer and AI-generated voice. `store:false` is not zero retention/ZDR assurance.
4. TTS outage is explicitly surfaced; local browser speech may be enabled as fallback and must be labelled as device voice. Do not call the experience local-only after any remote TTS use. No actual paid OpenAI request is part of the reported tests.
5. App source keeps working images/audio/results in memory, cancels stale work and revokes audio URLs; the Core production E2E reports consent, CSP, cache and cleanup checks. Recheck the built deployment and target browser before release. System/browser telemetry and OpenAI data handling are not controlled by this app.

## Firmware build/provisioning and target operation

Firmware owner reports ESP-IDF v5.5.4 cross-builds completed for S3 and CAM (CAM from exact scratch source snapshot). For reproducing, activate the compatible ESP-IDF environment, then from root:

    idf.py -C cam build
    idf.py -C proxy build

Build outputs are not hardware acceptance. Flash only using the actual board's configured target/port/partition table. Firmware procedure and secure offline credential generation are in [`firmware.md`](firmware.md). Create unique per-device secrets and real trusted certificate in private external storage; generated CSV/NVS contain credentials. Verify partition table before NVS write; never guess addresses or commit secret files. Unprovisioned/invalid NVS should leave radio/server disabled.

Topology: classic ESP32-CAM camera 0 sends original CAM2/JPEG to S3 SoftAP TCP5000; optional independent button channel TCP5001; authenticated TLS WSS `/ws` on S3 serves the phone. S3 AP+STA, router/client isolation, subnet collision, DNS, Wi-Fi channel contention, cellular routing and local-network browser permissions depend on the specific setup. No video may pass through a public service. ESP32-S3-CAM transmitter is not claimed supported.

## Acceptance checklist — hardware/deployment gates still open

Record revision, firmware/app build, command and exit code, target board, phone/OS/browser, topology, certificate result and sanitized evidence. Mark each as implemented, tested, hardware-gate, failed or not run:

1. Physical single camera ID 0 → S3 → phone; original 28-byte CAM2 and JPEG; no phone-camera access/fallback.
2. Decode real WSS bytes: VDX2 v1 24-byte envelope + 28-byte CAM2 + JPEG, JPEG offset 52, ≤1 MiB; confirm epoch/sequence, metadata/SOF. Verify auth-before-frames and reject wrong origin/host/token, malformed/oversized frames and stale sessions with trusted phone certificate.
3. Exercise physical resolutions 320×240, 640×480 and 1280×1024. ACK only after observed image dimensions; test timeout/refusal. Stress independent button control queue under streaming load, event delivery, heartbeat/reconnect and fail-closed overflow.
4. Exercise local worker runtime and WASM/JS fallback on devices; representative clear/obstacle/poor-quality/stale input; 3-new-frame alert/recovery; real-scene false positives/negatives, latency, thermal/power. Detector is not a distance or safety guarantee; exact OpenCV metric parity is not claimed.
5. Physical button OCR and product front/back capture; quality rejection/retry/cancel; prove only selected still reaches Vision after consent. Avoid live paid calls unless separately authorized.
6. TTS consent, model/body text-only, outage, optional fallback label, priority preemption, cancel/autoplay and object URL cleanup on target browser. No natural-voice/live API quality claim from mocks.
7. Inspect deployed network and storage (CacheStorage, IndexedDB, OPFS, logs): only static app assets cache; no frame/image/audio/text/key persistence; no app server/CDN/tunnel image path. Note OS telemetry and provider retention boundary.
8. Verify VoiceOver/TalkBack, reduced motion, safe areas/zoom and actual Android Chrome/iOS Safari local network, screen lifecycle, hotspot/AP+STA/cellular, reconnection and sustained operation. App suspends when hidden; screen-lock/background detection is unsupported.
9. Decide whether public authentication is a release requirement. Current BYOK in-browser session design is not a public multi-user credential architecture. No production credential/ephemeral token broker or public auth is implemented.

## Verified checks (team lead's independent union execution)

This DOCS update only read handoffs and checked links; it did not install, build, or run tests. The following are reports from the frozen owners/coordinator:

- Mobile formatting: `npm run format:check` exit 0.
- Mobile unit suite: `npm test` exit 0, 12 suites / 31 tests passed.
- Mobile strict TypeScript + Vite production build: exit 0. Production sandbox Playwright: 4 passed. `npm audit`: exit 0, 0 vulnerabilities. CORE handoff `mobile-handoff.md` records detailed coverage, including CSP/cache inspection and cancellation/consent checks.
- Firmware host tests after ESP-IDF environment activation: sanitized run, 7 C executables + 9 Python tests, skip 0, pass. S3 original project build exit 0; CAM exact scratch snapshot incremental build exit 0. Exact commands/log paths in [`firmware-handoff.md`](firmware-handoff.md); no live TLS/hardware.
- Legacy Python regression: exit 0, 145 passed, 61 subtests. Stereo test suite: exit 1, 32 passed, 4 subtests, 5 `Frame` constructor failures; coordinator reproduced the same five failures on clean baseline `f7f0ea496dc4a06bf15a98eee14e08dea186f071` (5 failed, 1 passed). This is a pre-existing research/stereo failure, outside the single-camera runtime; it was not modified.
- Vision WASM/detector: coordinator rerun 10 tests pass; SHA-256 `12fec71860403e0cbbb44222377249ac6cfefe99ab912ab731d1fdbe1666aecf`. UI scope checks also recorded. See `vision-handoff.md` and `ui-handoff.md`.

The authoritative independent result list is [`coordinator-validation.md`](coordinator-validation.md) (coordinator-owned; DOCS did not modify it). Physical hardware, trusted production WSS, mobile OS permissions/lifecycle, public authentication and live paid OpenAI remain unverified gates.