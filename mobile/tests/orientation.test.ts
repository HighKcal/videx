import { it, expect, vi } from "vitest";
import { orientedSize, drawOriented } from "../src/core/orientation";
it("default camera cw90 rotates walking and capture through same matrix", () => {
  expect(orientedSize(320, 240, "cw90")).toEqual([240, 320]);
  expect(orientedSize(320, 240, "none")).toEqual([320, 240]);
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    scale: vi.fn(),
  };
  drawOriented(ctx as any, {} as any, 320, 240, "cw90");
  expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
  expect(ctx.translate).toHaveBeenCalledWith(240, 0);
  drawOriented(ctx as any, {} as any, 320, 240, "ccw90");
  expect(ctx.rotate).toHaveBeenCalledWith(-Math.PI / 2);
  drawOriented(ctx as any, {} as any, 320, 240, "180");
  expect(ctx.rotate).toHaveBeenCalledWith(Math.PI);
});
