# Button diagnostics — bounded review / handoff

Task: `button-diagnostics-review`. Write scope: this document only. Source/tests are read-only; existing dirty changes are preserved. No builds, E2E, shared servers, firmware changes, flash, commit, push or credentials access. Parent owns final verification. Actual-board symptom is reported as “buttons produce no change”; its cause is not established by synthetic test passes.

## Historical input contract and an important physical distinction

Reference is `f7f0ea4`, not the dirty firmware tree. Read-only historical inspection found:

- `f7f0ea4:cam/main/main.c:40-42,190-212`: the button input is the LEFT camera's GPIO13-to-GND switch, active-low with internal pull-up; GPIO13 is shared with microSD. RIGHT builds return no button flags. This is not evidence that any S3 BOOT/reset/onboard switch is wired to that input. Confirm which physical switch the user is operating; do not infer a browser bug from an unrelated switch.
- `f7f0ea4:cam/main/main.c:366-370`: the current GPIO level is attached to captured images. `f7f0ea4:proxy/main/main.c:275-285` classifies incoming LEFT metadata and carries the persistent last result in outgoing CAM2. No independent no-JPEG button delivery is defined on this historical path.
- `f7f0ea4:proxy/main/button.h`: pressed/valid/classified are bits 0/1/2. Debounce requires 3 LEFT frames; LONG requires 30 LEFT ticks, not a fixed host wall-clock duration. Slow images change perceived hold time; missing frames can hide a short press. A LEFT stream gap over 2 seconds resets the firmware classifier (`f7f0ea4:proxy/main/main.c:277-278`).
- Classified flags 6=valid released, 7=valid pressed; result 0=NONE, 1=SHORT, 2=LONG. LAST result persists into the next press, so unchanged results are not evidence of missing input. Legacy raw flags 2/3 with result 0 are also supported. Flags 0 or 4 do not provide a valid level.

This narrows the evidence to collect; it does not authorize rewiring, flashing or a speculative production fix. Installed firmware identity and actual wiring have not been verified here.

## Existing browser gates: where an action can disappear

Line references below describe the pre-diagnostics source inspected for this review; final diagnostics changes may shift them.

1. Parser gate: `mobile/src/core/usb-wire.ts:155-205` accepts only complete CAM2 records with permitted camera/flags/result/reserved fields, bounded sizes and JPEG start/end markers. Malformed/incomplete/rejected records never reach a parsed-LEFT diagnostic. “Raw metadata” here must mean parsed CAM2 header metadata, not an electrical GPIO measurement or all bytes received over USB.
2. Source gate: `mobile/src/core/usb-source.ts:182-207` ignores RIGHT/paused frames and duplicate or backward LEFT frame IDs before `Cam2Buttons.observe()`. A moving RIGHT stream is not proof that LEFT buttons are reaching this gate. A backward/reset frame ID can be ignored until stale/reset recovery; record the frame ID and filter status rather than assuming all observed metadata was accepted.
3. Classifier gate: `mobile/src/core/usb-wire.ts:26-47` resets on invalid metadata or an observed LEFT gap over 2000 ms. The first valid level is only a baseline. It arms on released→pressed and emits only on pressed→released after that arm. A held LONG result by itself never cycles modes. Reconnect while held, missed pressed frames, or a gap before release can correctly produce no event. Classified release with result 0 also produces no action. Raw 2/3 levels use host duration (1000 ms threshold), unlike classified 6/7 levels.
4. Session gate: `mobile/src/core/usb-source.ts:150-175` checks read generation; stale watch `:122-137` resets parser/button history and marks UNKNOWN. Default constructor protocol is legacy (`:44-50,87-102`). CAM2 button classification is enabled only in legacy mode (`:205-206`); do not diagnose optional CDC2 controls as the default legacy path.
5. Dispatch gate: `mobile/src/core/controller.ts:145-154` maps SHORT→capture and LONG→cycle. The final controller dispatch record means the command was received/invoked, not that capture succeeded or asynchronous selection completed. Mode is updated by the queued selection (`:159-187`).
6. Visible-result gate: walking SHORT only repeats current guidance, not mode change (`mobile/src/modules/builtins.ts:35-44`). Recognition may report busy or wait for current high-resolution frames (`:116-129`), and API requests may be blocked by health or consent (`mobile/src/core/openai.ts:58-60`). Repeated captions are suppressed for 5000 ms (`mobile/src/core/feedback.ts:64-75`). Thus unchanged caption, silence, or zero network posts alone does not show missing physical input.

## Diagnostic interpretation

Use deltas within one connection, not absolute counts across an undocumented reset. Record connection/protocol, LEFT frame ID and age, flags/result, accepted source SHORT/LONG counts, last controller dispatch type/time, current module, actual frame dimensions, caption/error and speech status. The final panel has source event counts and a last-dispatch record, not separate controller dispatch counters. No image payload, credentials or persistent event log is required.

| Observation | Supported interpretation / next discriminator |
| --- | --- |
| No parsed LEFT metadata; input waiting/UNKNOWN | No evidence yet of a usable LEFT record. Distinguish absent LEFT images from parser rejection or a stale connection; do not claim that GPIO is broken. |
| LEFT frame IDs advance; flags remain 0 or 4 | Frames arrive but valid button levels are absent. Confirm historical firmware and the LEFT input; browser cannot reconstruct missing validity. |
| Accepted LEFT IDs advance; 6 stays released during the physical attempt | No debounced pressed level reached the browser. Check which switch was operated and capture a complete press/release interval; this alone does not locate the fault between switch, camera sampling, S3 classifier and dropped frames. |
| 7 appears while held; no count increment yet | Expected: host action is release-driven, even when LAST result is LONG. |
| 6→7→6 observed, classified result 1/2, source event count stays flat | Check that this exact sequence reached the classifier, was within the valid connection/gap window and had accepted IDs. If so, this is a concrete classifier discrepancy, not an API/consent problem. A latest-only snapshot cannot prove the complete sequence. |
| Repeated released 6/result 1 or 2, no fresh edges | Correct suppression of persistent LAST result. SHORT→SHORT and LONG→LONG must still count when each has new edges. |
| Source accepted-event count rises; controller dispatch record does not update | Boundary/callback/session discrepancy; inspect current source identity and callback handling. Do not change button timing to address a downstream dispatch problem. |
| Source event count rises and dispatch record updates; UI seems unchanged | Input is reaching application logic. For SHORT check selected module, ready/busy/consent/error and repeated-caption suppression. For LONG check queued module change/error, not speech alone. |
| 2/3 toggle with result 0 | Unclassified raw-level path: compare host-observed hold duration with 1000 ms, while maintaining LEFT delivery gaps below the reset threshold. Do not interpret result 0 as “no button” on this path. |

A single sampled flags/result label can miss a short 7 interval. Counts must be collected per parsed/accepted frame/event, not from React render transitions. If the panel lacks a prefilter observation or explicit filter outcome, it cannot distinguish absence of metadata from duplicate/backward-ID filtering; state that limitation instead of labeling it “no button received.”

## Criteria for mid's diagnostics-only change

- Observe parsed LEFT metadata before duplicate/backward-ID rejection if the panel claims to expose input excluded by those filters. Distinguish observed records, classifier-eligible frames and accepted events; keep actual acceptance rules unchanged.
- Preserve LAST-result semantics, first-frame baseline, held/released reconnect suppression, stale/reset behavior, repeated identical SHORT/LONG actions, raw 2/3 classification, RIGHT/pause exclusion and default raw mode-only writes. Diagnostics must not introduce USB2 negotiation, weaken validation or synthesize actions.
- Increment accepted source counters only at real source event emission; update the controller dispatch record (or counters, if supplied) only for the physical callback path. Manual UI capture/cycle must not be misreported as physical input. Counters/type need coherent reset/session semantics and must not repopulate from an obsolete read/callback after reconnect.
- Capture enough context to explain a rejection without treating parsed data as a physical GPIO measurement. Report no-data/invalid/stale honestly; a retained last sample after disconnect must not appear current.
- UI observes the counters without extra event dispatch, audio, provider request, persistent logging or blocking the read loop. A dispatch diagnostic must not claim asynchronous action completion. Existing consent/cancellation/generation guards remain unchanged.
- Parent's targeted tests should cover changed metadata with rejected IDs (if observable), all accepted events in coalesced reads, repeated results, raw/classified release, RIGHT exclusion, diagnostic resets/stale reads, source→controller count agreement and manual controls not inflating physical counts. Existing tests inspected at `mobile/tests/usb-source.test.ts:44-119` and `mobile/tests/usb-wire.test.ts:21-47` cover several behavioral invariants, not actual hardware reception.

## Review checkpoint and handoff

Final bounded reread completed after parent reported mid's panel and TypeScript work finished. Reviewed the new `ButtonDiagnostics`, `Cam2Buttons.decision`, per-event source counters, controller callback/dispatch record, new unit-test assertions and final panel labels read-only. This document is now frozen; lead owns execution and final verification.

Resolved finding — discarded raw level visibility: the initial snapshot lost the raw pressed bit for duplicate/backward frames. The final `mobile/src/core/usb-source.ts:17,216-227` now retains `rawFlags: frame.flags` before the ignored-ID return while keeping the interpreted `pressed` unknown for ignored frames. `mobile/src/main.tsx:123-132` separately renders the raw flags/bit0 and interpreted state. Thus ignored flags=7 vs flags=6 are distinguishable without weakening frame acceptance. The earlier observability finding is resolved by direct source inspection; this does not establish the actual-board symptom's cause. Runtime/test confirmation of this final adjustment is lead-owned.

Positive review evidence: `mobile/src/core/usb-source.ts:244-248,457-472` publishes scalar snapshots, increments accepted counters at actual event emission, and dispatches the existing control callback. Stale/disconnect clear the interpreted level to unknown while retaining counts, and start resets the diagnostic session (`:78-81,147-163,488-505`). `mobile/src/core/usb-wire.ts:27-61` adds decisions without changing the observed-release rules. `mobile/src/core/controller.ts:131-134,150-155` passes the diagnostics callback in the sixth constructor position with explicit legacy and records dispatch intent before the existing action. This does not claim capture success or clear consent/module errors. `mobile/tests/button-diagnostics.test.ts:30-95` adds metadata/baseline, coalesced-event, ignored-ID, stale/reconnect and explicit-CDC2 assertions. `mobile/tests/controller.test.ts:46-75` checks callback plumbing, dispatch intent and clearing on disconnect. Test execution remains parent-owned.

Resolved review dependency — final panel is visible at `mobile/src/main.tsx:104-159`. Labels now distinguish:

- `물리 버튼 진단 (LEFT)`, explicitly parsed CAM2 headers, not actual GPIO measurement (`:104-109`).
- `버튼 수신 상태`, with no-frame/live and explicit stale/disconnected past-sample warnings; recent parsed LEFT ID and monotonic receive time/age (`:112-122`).
- `최근 헤더 메타데이터 (지연/끊김 시 과거 표본)` and `헤더 원시 눌림 비트 (ID 필터 전, 현재 상태 아님)`, separately from `해석한 버튼 상태`, which renders unknown unless live (`:123-132`).
- `마지막 펌웨어 결과 (이벤트 횟수 아님)`, plus baseline/repeat/press/accepted/no-metadata/ignored-ID decision labels (`:133-143`).
- Session SHORT/LONG acceptance counts and recent accepted event (`:144-150`), separately from `최근 물리 버튼 앱 전달 (완료 여부 아님)` with request type, dispatch-time mode and timestamp (`:151-154`).
- Current mode, capture stage and existing error, plus explicit warning that acceptance/dispatch does not imply capture/recognition/upload success (`:155-158`).

No unresolved implementation defect was established in this bounded final static reread. Remaining limits are unchanged: latest-only metadata cannot prove every transient edge, parsed diagnostics cannot expose parser-rejected bytes or measure physical GPIO, and actual wiring/firmware identity/hardware cause remain unverified. Do not treat the resolved observability finding or visible panel as a hardware fix.

Worker verification performed: read-only source/test inspection, final panel/rawFlags reread and targeted `git show`/`git grep` of historical button code; no worker-run test/build/browser/hardware execution. Final coordinator evidence below is reported evidence, not an independent rerun by this worker.

## Final coordinator evidence — document frozen

- `npm test` — PASS, 115/115.
- `test:server` — PASS, 25/25.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e` — PASS, 21/21 in 56.6s, including build and TypeScript checking.
- Coordinator's fresh real-browser visit to `https://vt.ssammwu.info` loaded `index-F3afgeJS.js` and rendered `물리 버튼 진단 (LEFT)` with all labels, initial waiting state and zero counts. This confirms deployed panel visibility only; it does not demonstrate button reception or action dispatch.
- The rawFlags finding remains resolved by the final source inspection described above. No real board input was exercised; actual wiring, installed firmware identity and the hardware symptom's cause remain unverified. Synthetic WebUSB/provider suite results and a visible waiting panel are not hardware acceptance.

No additional checks or source/test edits were performed for this evidence update. This document is frozen.

SUPERSET_WORKER_DONE task:button-diagnostics-review files:docs/v2/button-diagnostics.md result:final labels reviewed;rawFlags finding resolved;coordinator evidence recorded;document frozen checks:coordinator unit 115/115,server 25/25,E2E 21/21 in 56.6s incl build/tsc PASS;fresh deployed panel visible with index-F3afgeJS.js handoff:no real board input exercised;hardware cause unverified;no source/test/firmware edits
