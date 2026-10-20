# VIDEX vision worker handoff

Scope: `mobile/src/vision/**`, `mobile/tests/vision*.test.ts`, this handoff. Corrected channel luminance (RGBA input), Canny threshold units, horizontal non-maximum suppression neighbors, and reset of temporal confirmation after a stale inter-frame gap. The detector uses baseline trapezoid/center/seed geometry, closing/dilation, ROI-bounded 4-connected flood fill, quality checks, 3-new-frame warning confirmation, 3-frame hysteresis release, UNKNOWN on invalid/stale input, and makes no distance/depth claim.

Baseline reference studied: `proxy/flood_fill.py`, `proxy/outline.py`, `proxy/test_flood_fill_mvp.py`, `proxy/test_flood_fill_api.py`, `proxy/fixtures/flood_fill_baseline.json`. Python `synthetic(30)` values in OpenCV 4.14.0: ROI=23760, center=4864, barriers=1034, filled=15853, unfilled=7907, total=0.3327861953, central=0.7734375, seed=(120,301). TS fixture reconstructs exactly the uniform 145 frame and filled (82,165)-(158,260) BGR=25 rectangle in equivalent RGBA. Observed TS total was 0.3439328415, showing numerical/mask parity is still not exact. Do not claim exact parity; Canny/morphology parity work remains.

Validation:
- `npm run test -- --run --pool=threads --maxWorkers=1 tests/vision-detector.test.ts`: exit 0, 8/8 passed. Includes exact-shape synthetic scene warning/hysteresis, malformed dimensions, bad-quality UNKNOWN, stale timeout, resolution reset with valid resized RGBA and separate malformed-length input, stale-gap reconfirmation.
- `./node_modules/.bin/tsc --noEmit`: exit 0.
- Exact baseline metrics comparison was attempted and failed (TS total 0.3439328415 vs Python 0.3327861953); test asserts category/threshold behavior, not exact metric parity. Need further kernel-level comparison before describing the port as geometrically/pixel exact.
- At VISION-2 check, only native rust target was installed; VISION-3 subsequently added the WASM artifact and verifies it below.
- No npm installation was run by VISION. Existing shared `mobile/node_modules` content and concurrent edits were preserved.

VISION-3: `mobile/src/vision/flood_fill.rs` provides an ROI-constrained, 4-neighbor Rust flood-fill kernel. Build reproducibly from that directory with `./build-wasm.sh`; checked-in output is `flood_fill.wasm`. `initializeVision()` loads once asynchronously and returns `wasm` or `javascript`; `visionRuntimeStatus()` exposes the active engine. `ObstacleDetector.analyze()` remains synchronous and uses the initialized WASM kernel for fill masks, falling back to JS on missing/failed module. The WASM parity test instantiates the actual checked-in artifact, invokes its exported kernel, and compares output masks against JS.

VISION-3 validation:
- `src/vision/build-wasm.sh`: exit 0; generated 17,403-byte artifact, SHA-256 `12fec71860403e0cbbb44222377249ac6cfefe99ab912ab731d1fdbe1666aecf`; second build produced the same hash.
- `npm run test -- --run --pool=threads --maxWorkers=1 tests/vision-wasm.test.ts tests/vision-detector.test.ts`: exit 0, 10/10 tests. Wasm test reads and instantiates checked-in binary and invokes kernel; direct Node invocation returned filled-count 8 and mask `[1,1,1,1,0,1,1,1,1]` for a 3x3 ROI with center barrier.
- `./node_modules/.bin/tsc --noEmit`: exit 0. `rustfmt --edition 2021 --check src/vision/flood_fill.rs`: exit 0. `npm run build`: exit 0; Vite emitted `assets/flood_fill-CijwzEMq.wasm` (17.40 kB, gzip 7.59 kB) into dist and bundled the worker.
- Explicit missing-URL test reports `javascript`, and fallback mask stays functional.

CORE integration handoff: call `initializeVision()` from the worker before frame processing and surface `visionRuntimeStatus()` to diagnostics. CSP must permit WebAssembly compilation (`'wasm-unsafe-eval'` in `script-src` where required). Loading/init failure keeps JS fallback active and must not be described as WASM. No node_modules or package manifest changes were made by VISION.

Remaining limitations: exact OpenCV Canny/ROI/morphology metric parity is not established (prior synthetic total differed). Hardware/browser integration and production CSP behavior were not tested. Rust/WASM kernel accelerates only the flood-fill phase; no end-to-end speedup claim.
