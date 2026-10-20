# VIDEX v2 specification notes and frozen implementation status

## Specification interpretation

The team brief, Korean architecture/privacy Markdown, HTML reference and all 11 rendered PDF pages were reviewed. The PDF describes camera-glasses video → phone visual analysis → voice guidance for blind/low-vision users, and names obstacle detection, product recognition and text reading. It requires obstacle outline/ROI analysis and warning after three consecutive frames; button-triggered image recognition and voice feedback; the slides name GPT-4.1 mini and GPT-4o-mini-tts. The HTML is authoritative for two white bar eyes (not PDF plus/star eyes). Module colors: walking `#FF5033`, OCR `#3978F6`, object `#865CEB`.

The team brief fixes the wire contract. User correction overrides the Markdown ban on remote TTS: speech text goes directly to OpenAI TTS (`gpt-4o-mini-tts`), never image. Only user-selected stills may go directly to OpenAI Vision. Disclose both transfers and the AI voice; `store:false` does not guarantee zero retention.

## Fixed protocol

- CAM → S3: original 28-byte little-endian CAM2 header + JPEG over local TCP; one camera, ID 0.
- S3 → PWA: one binary WSS message: 24-byte VDX2 envelope + original 28-byte CAM2 + JPEG. Envelope offsets: magic `VDX2` at 0; u16 version 1 at 4; u16 header size 52 at 6; u32 epoch at 8; u32 sequence at 12; u64 S3 receive monotonic microseconds at 16; CAM2 at 24; JPEG at 52; max JPEG 1 MiB.
- WSS `/ws`, exact configured Host/Origin, valid TLS and authentication before frame/control output. No public image proxy. Independent monotonic clocks must not be subtracted.
- Controls are separate JSON and reliable; video may use latest-frame replacement. Control overload fails closed. Resolution modes 0=320×240, 1=640×480, 2=1280×1024; ACK reflects observed actual JPEG dimensions only.

## Implementation and test evidence (not hardware acceptance)

- Mobile code, UI, modules, controller, capture, direct OpenAI transports, worker, detector, and Rust/WASM flood-fill kernel are implemented. Core frozen handoff [`mobile-handoff.md`](mobile-handoff.md) records how the UI/Vision contracts were integrated.
- Coordinator's union mobile results: format check 0; 12 test suites / 31 tests pass; strict TypeScript + Vite build 0; production sandbox Playwright 4 pass; audit 0 vulnerabilities. Detailed scope is in `mobile-handoff.md` and coordinator-owned `coordinator-validation.md`.
- Firmware source/provisioner implemented. Firmware handoff [`firmware-handoff.md`](firmware-handoff.md) reports sanitizer host tests (7 C, 9 Python, skip 0), S3 original build 0 and CAM exact scratch snapshot incremental build 0.
- Vision's final handoff reports 10 targeted tests and coordinator rerun pass, reproducible WASM artifact SHA-256 `12fec71860403e0cbbb44222377249ac6cfefe99ab912ab731d1fdbe1666aecf`. The Rust kernel accelerates flood-fill only. Exact full OpenCV mask/metric parity is not established; no full pipeline speed or field safety claim.
- Stereo regression remains exit 1 with five `Frame` constructor failures reproduced on clean baseline. This research/stereo suite is outside v2's one-camera runtime; no unrelated fix was made.

These are scoped, reported automated tests/builds—not claims that the camera, TLS, local network or mobile platform works in the field. See [`coordinator-validation.md`](coordinator-validation.md) for independent union results, without modifying that coordinator-owned file.

## BYOK credential and privacy limitation

The app accepts the user's own API key in the browser session, keeps it in memory, clears it on disconnect, and sends selected stills/text only to the respective direct OpenAI endpoints after separate consent. There is no ephemeral credential broker for Responses/TTS. Realtime ephemeral credentials must not be assumed valid for these endpoints. This is a private trusted user-session mode, not a suitable public multi-user service. Never embed a long-lived key into build artifacts, share a common key, or invent a public token endpoint. Rotate/revoke a key if exposed. User must understand OpenAI receives selected images/text and `store:false` is not ZDR. No real paid API call was made.

## Hardware/deployment release gates remain

Not verified: physical flash/boot/real camera frames and GPIO button; real WSS/TLS trust, per-device provisioning and DNS; resolution/control behavior over Wi-Fi; Android/iOS local network permissions, screen-reader and lifecycle behavior; hotspot/AP+STA/cellular coexistence; real-scene detection quality, FPS/latency, power/thermal performance; actual OpenAI key/CORS/account/audio behavior; public authentication. No stereo distance measurement, clear-path guarantee, background/screen-lock monitoring or safety-certified use is promised. Operational steps and evidence are in [`validation.md`](validation.md) and [`firmware.md`](firmware.md).