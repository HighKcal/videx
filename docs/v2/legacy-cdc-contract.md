# Unmodified f7f0ea4 CAM2 CDC contract

## Scope and decision

Acceptance target: the already-installed board firmware from `f7f0ea4`, without rebuilding or flashing it, drives the current browser app through native USB CDC. Firmware, deployment, credentials and production modules are outside this review's write scope. Default browser operation is legacy CAM2, not active USB2 discovery.

Historical evidence was inspected with `git show f7f0ea4:<path>`; the current dirty firmware tree is not the compatibility reference:

- `proxy/main/main.c:94-114`: `usb_command_task()` consumes each host byte independently. It accepts raw `0x00`, `0x01`, `0x02`, also maps ASCII `0`..`2`, and ignores other values. There is no USB2 negotiation parser.
- `proxy/main/main.c:275-285`: LEFT frame metadata is classified by `button_update()` and transmitted using `button_output_flags()` plus persistent `button.last_result`. Classification is driven by completed LEFT frames, not an independent USB event channel.
- `proxy/main/button.h`: debounce is 3 LEFT ticks; long threshold is 30 LEFT ticks. `last_result` persists until another classified result or classifier reset.
- `proxy/viewer.py`: `HEADER = struct.Struct("<IBBBBIIHHQ")`, `resolution_command()`, `FrameParser`, `ButtonEvents` and `receive_frames()` define historical host behavior.
- `app/object_recognition/usb_source.py`: `CAM2_HEADER`, `resolution_command()`, `_request_resolution()` and `request_resolution()` corroborate the same wire and explicitly distinguish a sent command from observed dimensions.

## Device to browser: CAM2

Each image is a packed 28-byte little-endian header followed immediately by its JPEG. USB reads may split or concatenate records; read boundaries are not record boundaries.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | literal ASCII `CAM2` (`0x324d4143` as LE uint32) |
| 4 | 1 | camera id: LEFT=0, RIGHT=1 |
| 5 | 1 | flags |
| 6 | 1 | last classified button result |
| 7 | 1 | reserved, zero |
| 8 | 4 | frame id |
| 12 | 4 | JPEG byte length |
| 16 | 2 | width |
| 18 | 2 | height |
| 20 | 8 | camera timestamp, microseconds |

Normal JPEG length is 4..1048576; dimensions are 1..4096; JPEG begins `ff d8` and ends `ff d9`. Historical valid flag/result combinations are:

- Flags 0, result 0: ordinary frame without usable button metadata.
- LEFT flags 2/3, result 0: valid raw released/pressed level.
- LEFT flags 4, result 0: classifier present but no valid baseline yet.
- LEFT flags 6/7, result 0/1/2: classified valid released/pressed level, with NONE/SHORT/LONG persistent result.
- RIGHT pause record: camera 1, flags 8, result/reserved/length/width/height all zero; header only. It is not an independent button record or a LEFT image.

The browser uses LEFT image metadata for legacy buttons. RIGHT frames and pause records must not generate button actions.

## Browser to device: mode only

Every application bulk OUT transfer in the default path must contain exactly one raw byte, 0, 1 or 2. Do not send JSON, newline, USB2 hello/ping/resolution envelopes, or an automatic discovery probe. Although historical firmware also accepts ASCII digits, the Python host baseline and browser regression require raw bytes.

| Raw byte | Requested size | Historical camera scope |
| --- | --- | --- |
| 0 | 320×240 | both cameras |
| 1 | 640×480 | LEFT only; RIGHT paused |
| 2 | 1280×1024 | LEFT only; RIGHT paused |

The app requests mode 0 for walking and mode 2 for OCR/front-back recognition. Legacy has no request id or wire ACK: successful USB transfer is not proof of applied resolution. Recognition must wait for a fresh observed LEFT frame matching the requested dimensions. No matching frame must result in waiting/timeout, never upload of an old low-resolution image.

The earlier unconditional USB2 hello was unsafe: `USB2` contains an ASCII `2`, and binary envelope header fields include raw 0/1 values. The old receiver interprets those as mode changes byte by byte. A 1500 ms fallback cannot undo those commands. Do not make a legacy fixture reply with a USB2 connected or resolution ACK to conceal this bug.

## Physical button semantics

- Establish a baseline on the first valid LEFT level; a persistent result at startup is not an action.
- Arm only after an observed released→pressed transition. For classified metadata, emit once on the subsequent pressed→released transition using that release frame's result.
- LONG may first appear while still pressed. The historical host acts at release, not once per held frame or when the result first changes.
- Result is LAST result, not an event counter: SHORT→SHORT and LONG→LONG are distinct actions only when each has its own physical edges. The previous result can still be present throughout the next press; LONG→SHORT must not spuriously cycle modes.
- Missing/invalid metadata, stream staleness and disconnect clear button history. Reconnecting released with an old LONG, or reconnecting held then releasing it, must not replay an action. A new complete press/release must still work.
- Short executes the selected function; long cycles walking→OCR→object→walking. Consent, current resolution and capture generation remain applicable to physical inputs.

## Limits and optional CDC2

Legacy cannot deliver buttons independently while LEFT JPEG frames are unavailable. It has no firmware session epoch or event-id deduplication guarantee. Missed physical transitions during a stream gap cannot be reconstructed from LAST result alone. Host generations must still invalidate delayed image/AI results on mode change, capture restart, consent withdrawal and disconnect/reconnect.

Current frozen `UsbFrameSource` exposes an explicit constructor protocol argument defaulting to `legacy` (`mobile/src/core/usb-source.ts:44-50`), and guards hello with the explicit `cdc2` choice (`:87-102`). `AppController.configure()` constructs the source without that opt-in. Thus default UI tests must be CAM2. Optional CDC2 event-id/session/no-JPEG/ACK guarantees remain explicit-opt-in unit coverage; no browser fixture may invent a negotiation path absent from the UI.

Resolved (lead-reported): mid corrected the automatic-protocol wording in `mobile/src/main.tsx` with the legacy-copy change, aligning the UI with legacy-default operation. No wording fix remains pending. `docs/v2/cdc-protocol.md` describes the extension, not the unmodified-board baseline.

## File handoff

This contract is the core/unit owner's compatibility handoff and the lead's E2E oracle. Lead reported the full browser suite PASS (20/20 in 53s), then rebuilt and reran `legacy-cdc.spec.ts` plus `cdc-only.spec.ts` against the final legacy-copy change: PASS, 5/5 in 10.7s, using `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome`; final `git diff --check` also PASS. See `legacy-cdc-validation.md` for exact changed files, coverage mapping and verification attribution. Evidence is synthetic WebUSB/provider only; actual board, Android, paid API and live deployment remain unverified. No firmware change, flash, commit, push, deploy, live provider request or lead-terminal contact was performed.
