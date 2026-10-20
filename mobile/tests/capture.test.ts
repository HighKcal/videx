import { it, expect } from "vitest";
import { CaptureSession, assessQuality } from "../src/core/capture";
it("requires separate explicit front/back captures, rejects poor quality and clears on reset", () => {
  const session = new CaptureSession();
  session.begin("object");
  expect(session.stage).toBe("front");
  expect(() => session.accept("bad", { ok: false, reason: "흐림" })).toThrow(
    "흐림",
  );
  session.accept("front", { ok: true, reason: "ok" });
  expect(session.stage).toBe("back");
  expect(() => session.accept("front", { ok: true, reason: "ok" })).toThrow();
  session.accept("back", { ok: true, reason: "ok" });
  expect(session.stage).toBe("ready");
  expect(session.images).toEqual(["front", "back"]);
  session.reset();
  expect(session.images).toEqual([]);
});
it("rejects underexposure, overexposure and flat blurry frames; accepts detailed contrast", () => {
  for (const v of [0, 128, 255]) {
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(v);
    expect(assessQuality(pixels, 64, 64).ok).toBe(false);
  }
  const p = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      p[i] = p[i + 1] = p[i + 2] = x % 4 < 2 ? 55 : 200;
      p[i + 3] = 255;
    }
  expect(assessQuality(p, 64, 64).ok).toBe(true);
});
