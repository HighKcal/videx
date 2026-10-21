# Legacy CAM2 CDC browser regression — validation handoff

Status: source/E2E frozen; final lead verification PASS. Compatibility contract: [legacy-cdc-contract.md](legacy-cdc-contract.md).

## Task and preserved scope

Task `legacy-review` inspected unmodified `f7f0ea4` wire/button behavior, migrated default browser regressions from assumed automatic CDC2 negotiation to historical CAM2, and published the contract. Ownership expanded to all `mobile/tests/e2e/*`; core and unit tests remained mid-owned and read-only. Existing dirty changes and pre-existing deleted tests were preserved. No firmware edits, flash, commit, push, deployment, secrets access or lead-terminal contact were performed.

Exact files changed by this worker, relative to `/home/minwoo/.superset/projects/videx`:

- `docs/v2/legacy-cdc-contract.md` — new historical wire/button/default safety contract and resolved production wording finding.
- `docs/v2/legacy-cdc-validation.md` — this validation and file handoff.
- `mobile/tests/e2e/cdc-fixtures.ts` — legacy-only default WebUSB boundary; raw OUT byte evidence; historical per-byte mode receiver; persistent LAST result through press/release and USB reopen; no fabricated USB2 response.
- `mobile/tests/e2e/legacy-cdc.spec.ts` — repeated SHORT captures, persistent-result suppression, consecutive LONG mode cycles, raw mode-only OUT assertions.
- `mobile/tests/e2e/cdc-events.spec.ts` — no-JPEG limitation, reconnect baseline held/released, stale video recovery, and delayed OCR cancellation matrix.
- `mobile/tests/e2e/cdc-integration.spec.ts` — real local Node integration retained on the actual UI's legacy default, including consent, OCR/front-back, synthetic TTS bytes/playback, same-origin and no browser credentials.
- `mobile/tests/e2e/usb.spec.ts` — retained parsing/worker/unplug/chooser coverage; strengthened complete OUT transfer byte assertions.

Reviewed but not edited here: `cdc-only.spec.ts`, `cdc-privacy.spec.ts`, `backend-fixture.ts`; production source and peer-owned unit tests. Privacy/service-worker tests now use the migrated legacy default without source edits.

## Historical finding and resolution

Historical references: `f7f0ea4:proxy/main/main.c`, `proxy/main/button.h`, `proxy/viewer.py`, and `app/object_recognition/usb_source.py`.

The old board receives one-byte mode commands and sends packed `<IBBBBIIHHQ` CAM2 headers plus JPEG. LEFT button flags 6/7 mean classified valid released/pressed; result 0/1/2 means NONE/SHORT/LONG. The result persists across subsequent frames, including the next press. A fresh observed press/release, not result inequality, determines a new host action.

The previously unconditional USB2 hello was a concrete compatibility blocker: the historical receiver consumes bytes individually, including ASCII `2` in `USB2` and raw 0/1 bytes in its envelope, as mode commands. A fake legacy handshake would hide this bug rather than test the installed board.

At source freeze, the mid-owned implementation has an explicit `UsbFrameSource` constructor protocol argument defaulting to `legacy` and sends hello only for explicit `cdc2`; the controller uses the default. Browser fixtures consequently emit CAM2 only and record complete raw OUT transfers. No CDC2 browser fixture or production API bypass remains.

## Coverage mapping — no silent skips

- Startup and mode changes: browser default uses raw one-byte modes only, never binary hello/ping/resolution records. Actual high-resolution frame dimensions are observed before recognition.
- Repeated controls: SHORT→SHORT uploads once per physical release; stable released LAST SHORT does not upload again. LONG→SHORT retains the previous LONG during the new press without cycling spuriously. Consecutive LONGs cycle OCR→object→walking once each; persistent released LONG does not cycle again.
- Reconnect: stale LONG at released startup is only a baseline. Reconnect while held and subsequent release is not a new action. A fresh press/release with the same LAST value works. A video stall clears an armed press; recovered released metadata does not replay it.
- Cancellation: separate parameterized browser cases cover physical mode change, consent withdrawal, unplug/reconnect and capture restart while an OCR response is pending. Delayed private results must not replace current captions. Reconnect/restart can produce a fresh result; withdrawal prevents further upload.
- Consent/privacy: retained no-consent provider silence, separate photo/speech consent, post-withdrawal silence, no browser credential prompts/storage, same-origin CSP, static-only service-worker cache, offline app and non-disruptive waiting service-worker update during unsaved front-side capture.
- Integration: retained local Node request validation, OCR and merged front/back recognition, synthetic audio response bytes and playback, browser/server credential separation, worker processing and explicit chooser activation/cancellation.
- CDC2-specific independent-no-JPEG delivery, event-id deduplication, epoch faults and negotiated ACK semantics are not legacy capabilities. They are represented by explicit `harness("cdc2")` unit coverage owned by mid, not skipped browser tests or fabricated default negotiation. Legacy browser coverage explicitly demonstrates that transitions missed without LEFT JPEG metadata cannot be replayed from LAST result.

## Actual verification

Worker execution before freeze:

- Formatted only the five changed E2E TypeScript files listed above with the installed Prettier executable.
- `npx tsc --noEmit` — PASS, exit 0.
- Prettier `--check` on those five files — PASS, all matched files use Prettier style.
- `git diff --check` — PASS, exit 0 at the pre-documentation check. This command does not inspect untracked files; it is not claimed as a complete artifact validator.
- No worker-run server, build, browser E2E, firmware test or live provider call. E2E/source edits stopped when lead requested freeze; subsequent writes were documentation only.

Final lead-reported verification against frozen source:

- `npm test` — PASS, 110/110.
- `npm run test:server` — PASS, 25/25.
- First default `npm run test:e2e` attempt failed only because the Playwright cached browser executable was missing; this was not an application regression.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e` — PASS, 20/20 in 53s. This run includes TypeScript checking and Vite build. `chromiumSandbox: true` remained unchanged.
- Final focused recheck after mid's `mobile/src/main.tsx` legacy-copy wording fix: lead rebuilt and reran `legacy-cdc.spec.ts` plus `cdc-only.spec.ts` — PASS, 5/5 in 10.7s, with the same `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome` environment. This supplements, not replaces, the prior full 20/20 PASS.
- Final lead-reported `git diff --check` — PASS.

These final suite results were supplied directly by lead; this worker did not rerun them or inspect another terminal. Browser/device evidence is synthetic WebUSB plus synthetic provider responses; Node integration is local. Passing these checks does not establish hardware, paid-provider or deployment acceptance.

## Remaining handoff and limits

- Actual unmodified board, USB electrical/driver behavior, Android Chrome permission/OTG compatibility and physical buttons are unverified on hardware.
- Paid API calls, live deployment, real provider speech and operational privacy/retention are unverified. No claims of production deployment or hardware success are made.
- Legacy cannot deliver independent controls while LEFT JPEG metadata is absent; there are no firmware event IDs/session epochs to retrofit in a browser fixture.
- Resolved (lead-reported): mid fixed the automatic-protocol wording in `mobile/src/main.tsx` with the legacy-copy change. The final focused recheck above covers that final copy; no production wording issue remains pending. This worker did not edit production source.
- Contract handoff is `docs/v2/legacy-cdc-contract.md`. No additional source/test edits are pending for this worker; lead owns subsequent integration decisions.

SUPERSET_WORKER_DONE task:legacy-review result:legacy contract published; browser defaults migrated to historical CAM2; E2E/source frozen;legacy-copy wording finding resolved files:docs/v2/legacy-cdc-contract.md;docs/v2/legacy-cdc-validation.md;mobile/tests/e2e/cdc-fixtures.ts;mobile/tests/e2e/legacy-cdc.spec.ts;mobile/tests/e2e/cdc-events.spec.ts;mobile/tests/e2e/cdc-integration.spec.ts;mobile/tests/e2e/usb.spec.ts checks:worker tsc+scoped-format PASS;lead npm-test 110/110,server 25/25,system-Chrome full E2E 20/20 in 53s PASS;final focused E2E 5/5 in 10.7s and git-diff-check PASS handoff:hardware/Android/paid-API/live-deployment unverified;no pending wording fix;no firmware/flash/commit/push/deploy
