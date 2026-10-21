import { afterEach, expect, it, vi } from "vitest";
import { selectFrame, mergeSides } from "../src/core/capture";
import { frame } from "./frame-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function canvasHarness(value = 128) {
  const canvases: any[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas: any = {
        width: 0,
        height: 0,
        toDataURL: vi.fn(() => "data:image/jpeg;base64,selected"),
      };
      canvas.getContext = () => ({
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        drawImage() {},
        fillRect() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(value),
        }),
      });
      canvases.push(canvas);
      return canvas;
    },
  });
  return canvases;
}
it.each([0, 128, 255])(
  "main manual capture accepts decoded flat/blurred/dark/bright content %s without invented quality gate",
  async (value) => {
    const canvases = canvasHarness(value);
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", async () => bitmap);
    const selected = await selectFrame(
      { ...frame(), width: 640, height: 480 },
      "cw90",
    );
    expect(selected.quality.ok).toBe(true);
    expect(canvases[0].toDataURL).toHaveBeenCalledWith("image/jpeg", 0.95);
    expect([canvases[0].width, canvases[0].height]).toEqual([480, 640]);
    expect(bitmap.close).toHaveBeenCalledOnce();
  },
);
it("still rejects mismatched decoded dimensions and releases the bitmap", async () => {
  canvasHarness();
  const bitmap = { width: 1, height: 1, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", async () => bitmap);
  await expect(selectFrame(frame())).rejects.toThrow(/크기/);
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it("uses main object merge bounds 1200 high/1800 wide and JPEG90", async () => {
  const canvases = canvasHarness();
  const bitmap = { width: 1280, height: 1024, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", async () => bitmap);
  await mergeSides([
    "data:image/jpeg;base64,AA==",
    "data:image/jpeg;base64,AQ==",
  ]);
  expect([canvases[0].width, canvases[0].height]).toEqual([1800, 720]);
  expect(canvases[0].toDataURL).toHaveBeenCalledWith("image/jpeg", 0.9);
  expect(bitmap.close).toHaveBeenCalledTimes(2);
});
