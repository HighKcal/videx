# Camera diagnostics preview — bounded review

Task: `camera-preview-review`. Owned file: this document only. Source/tests are read-only. No source/test edits, builds, shared servers, browser runs, firmware changes, credentials access, commit or push. Parent owns tests and public UI verification. Preview is an inspection aid, not a fix for physically blurry images or OCR accuracy.

## Where to use it / what it shows

Place the live LEFT camera preview near the top of the developer diagnostics screen, reachable from `VIDEX 진단 및 설정 열기`, before the long settings/diagnostics content. It should help check framing, focus, rotation and received resolution without taking a recognition photo or enabling upload.

Distinguish these explicitly:

- Live preview: the most recent usable LEFT JPEG, with the current camera rotation, and honest received/output dimensions. It can change after the physical capture button was pressed. It is not a frozen captured OCR image and not proof that the server received that image.
- OCR input: `mobile/src/modules/builtins.ts:121-159` selects a specific current frame at action time, checks readiness/freshness, applies rotation, quality-checks and re-encodes it before the existing consented API path. Object recognition uses two selected sides and a merged image, not the latest preview alone.

A visible preview does not prove that high-resolution capture is ready, a physical button was received, image quality passed, or an upload/recognition succeeded.

## Existing image path — evidence for comparison

- `mobile/src/core/orientation.ts:1-30`: shared `Rotation`, `orientedSize()` and `drawOriented()` implement none/cw90/ccw90/180. Quarter-turns swap canvas dimensions; rendering rotates/translates rather than mirrors. Preview must use this same orientation contract, not an unrelated CSS-only transform.
- `mobile/src/core/capture.ts:67-95`: `selectFrame()` decodes JPEG, rejects decoded/header dimension mismatch, allocates the oriented full-size canvas and draws with the shared helper. The 320-wide sample is only for quality assessment; OCR export is the full oriented canvas re-encoded as JPEG at quality 0.9. The decode bitmap closes in `finally`.
- `mobile/src/core/capture.ts:98-122`: front/back merging may resize the selected sides and combines them; the live view cannot be labeled as that composite.
- `mobile/src/core/controller.ts` before preview changes: default rotation is cw90 (`:37`); capture and walking receive the same setting (`:74-76,244-248`). Frame callbacks retain the actual latest received frame (`:97-107`), connection changes clear it (`:110-126`), and disconnect clears it (`:250-266`). These line numbers are pre-preview reference points and may shift.
- `mobile/src/core/walking.worker.ts:23-39,65-67`: walking decodes, validates dimensions and scales for local analysis, then closes its bitmap. Its downscaled analysis output must not replace native-resolution preview evidence.

## Narrow acceptance / review criteria

1. Orientation and actual dimensions: preview uses the same shared draw/size helpers and current `state.rotation`; rotation changes invalidate any in-flight old-orientation draw. Display decoded/header-validated received dimensions, not merely requested mode. During a resolution transition the live image may still be low-resolution; do not imply readiness or upscale it into fictitious detail.
2. Aspect and native pixels: the canvas backing dimensions reflect the full oriented decoded JPEG. Fit-to-width CSS preserves aspect without stretching/cropping; any native/1:1 inspection mode must actually show backing pixels at natural scale, with scrolling if needed. A shrunken CSS fit view is not a 1:1 sharpness test.
3. Stale/unplug/lifecycle: connection UNKNOWN/disconnected, old frame, diagnostics close/unmount and session change clear the displayed image and frame label. A slow decode finishing after clear/rotation/reconnect must not restore obsolete pixels. Old canvas contents must not remain while labels claim a new rotation or fresh session.
4. Decode order and resource bound: at most one active decode plus a bounded latest pending frame, or an equivalently explicit bound. Guard asynchronous completion with generation/frame/rotation context before drawing. Superseded/invalid/failed bitmaps close in all paths; object URLs, timers, listeners and pending references are released. Do not spawn a decode for every render or accumulate a promise/frame queue.
5. Diagnostics-only processing: enabling/decoding/redrawing the preview is limited to the diagnostics screen. Main-screen operation must not add an independent JPEG decode loop. Turning preview off must invalidate pending work; normal walking/recognition behavior must be unchanged.
6. Privacy and OCR independence: no additional fetch/upload, storage, service-worker image caching, screenshot export or consent bypass. Preview must not modify source JPEGs, capture session images, quality gates, actual-resolution acknowledgment or button dispatch. The displayed live frame is not the captured OCR payload.

These criteria specify the requested preview boundary, not a redesign of capture/OCR.

## Implementation review / handoff

Final bounded source reread completed for `preview-renderer.ts`, the controller preview accessor, `CameraPreview.tsx`, its CSS and diagnostics placement. The earlier findings described an intermediate RED stub, not the final implementation; their final status is recorded below. This document is now frozen. No worker-run tests/build/server/browser checks were performed.

Resolved findings:

- Stale/boundary invalidation — resolved. `mobile/src/core/preview-renderer.ts:30-49` now keys context by version/rotation/frame epoch/connection, increments generation and clears canvas/pending work at boundaries or unavailable/stale input. `:60-63,73-79` checks age before decode and after asynchronous completion, rejects old generations, and validates decoded/header dimensions. Missing frames, UNKNOWN/unplug and rotated/reconnected contexts no longer depend on accessor filtering alone to invalidate a previous draw.
- Unbounded/parallel decode and out-of-order completion — resolved. `preview-renderer.ts:51-66` keeps one latest pending frame and one busy decode. `:90-94` closes every completed bitmap, releases busy and pumps the bounded pending slot. `:99-107` invalidates on detach without resetting busy, so an unresolved old decode cannot overlap a new one on reopen. `mobile/src/main.tsx:20-21` retains that same renderer across hide/reopen. This is static source confirmation, not an independent stress-test result.

Final component / lifecycle evidence:

- Placement is near the top of the developer screen: `mobile/src/main.tsx:65-84` mounts the preview immediately after the heading/back button and only in the diagnostics branch. Constructing the retained renderer does not itself decode on the main screen.
- `mobile/src/ui/CameraPreview.tsx:11-23` attaches/subscribes only while mounted, updates every 250 ms to expire a stalled image even without a new source notification, and removes the timer/subscription plus detaches on unmount. `:32-44` exposes no-frame/loading/live/stale/disconnected/error states and hides the canvas unless live.
- `mobile/src/core/controller.ts:49-55,244-260` supplies current rotation/version/connection and blocks the prior frame across invalidation until new input. `preview-renderer.ts:79-84` validates JPEG dimensions and uses shared `orientedSize`/`drawOriented` at full backing resolution, not the walking worker's reduced image.
- `mobile/src/diagnostics.css:66-72` uses auto width/height with max-width/max-height, preserving aspect without stretching or unconditional upscaling. It is a fit view; there is no separate native 1:1 zoom control. `CameraPreview.tsx:46` correctly distinguishes internal native canvas pixels from fit-to-screen presentation. Do not infer optical sharpness at native display scale from the fitted view.
- `CameraPreview.tsx:30-31` labels this as `실시간 LEFT 카메라 미리보기` and explicitly says it differs from the last OCR photo, applies recognition rotation, and performs no sharpness correction or automatic transmission. The reviewed helper/component add no upload, persistent storage, object URL or recognition/capture operation.

Minor dimension-label finding — resolved by final coordinator report. `preview-renderer.ts` reports source `frame.width/height`, not the quarter-turned canvas dimensions; the final metadata copy now explicitly says `원본` dimensions. The earlier `표시 frame` ambiguity is no longer pending. It was a copy distinction, not a pixel/orientation or decode-safety defect; this reviewer did not edit production code.

Authored `mobile/tests/camera-preview.test.ts:17-98` covers bounded decode, mode/session/rotation/stale/disconnect/hide invalidation and expiry during decode; `:101-130` covers JPEG errors/dimension mismatch and supported rotations. This worker read tests only; the final execution/public UI results below were supplied by the coordinator, not independently rerun here.

## Final coordinator evidence — document frozen

- `npm test` — PASS, 132/132.
- Initial full E2E: 21 passed, 1 failed due to the exact nested camera-rotation label selector. The selector was corrected to a role `combobox` with a regex; this was a test-selector issue, not a demonstrated preview rendering defect.
- Final full system-Chrome `npm run test:e2e` — PASS, 22/22, including preview pixel rendering, rotation, stale clearing and no extra upload. Build/TypeScript checking and `git diff --check` also PASS, as reported by the coordinator.
- Fresh public browser check at `https://vt.ssammwu.info` served `index-DibMjOeA.js` and showed `실시간 LEFT 카메라 미리보기` near the top of diagnostics. No device was attached. This verifies deployed preview placement/visibility only, not real camera reception or recognition quality.
- Both intermediate renderer findings and the minor dimension-copy finding are resolved within this review's scope. Browser test evidence uses synthetic input; physical image/OCR quality remains unverified. No firmware or quality-threshold changes were made for this work.

No further checks or source/test edits were performed by this reviewer for this evidence update. Document frozen.

Physical focus, motion blur, camera mounting, real-board image quality and OCR improvement remain unverified. Do not report them as fixed by adding preview.

SUPERSET_WORKER_DONE task:camera-preview-review files:docs/v2/camera-preview.md result:renderer and copy findings resolved;final coordinator evidence recorded;document frozen checks:coordinator unit 132/132,system-Chrome full E2E 22/22 incl preview pixels/rotation/stale/no-upload PASS;build/tsc/git-diff-check PASS;public index-DibMjOeA.js preview visible handoff:no device attached for public check;hardware image/OCR quality unverified;no firmware or quality-threshold changes;reviewer documentation-only
