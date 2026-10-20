import { it, expect, vi } from "vitest";
const capture = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../src/core/capture", async () => {
  const actual = await vi.importActual("../src/core/capture");
  return { ...actual, selectFrame: capture.select };
});
import { builtInModules, type ModuleHost } from "../src/modules/builtins";
it("cancels delayed image selection and delayed vision across mode/disconnect so no late upload/result", async () => {
  const say = vi.fn(),
    vision = vi.fn();
  const host = {
    ai: { vision },
    walking: {},
    frame: () => ({ width: 1280, receivedAt: performance.now() }),
    ready: () => true,
    rotation: () => "cw90",
    say,
    error: vi.fn(),
    changed: vi.fn(),
  } as unknown as ModuleHost;
  const ocr = builtInModules(host)[1];
  await ocr.activate();
  let resolveSelection!: (v: any) => void;
  capture.select.mockImplementationOnce(
    () => new Promise((resolve) => (resolveSelection = resolve)),
  );
  const selected = ocr.onShort!();
  ocr.cancel!();
  resolveSelection({ image: "selected", quality: { ok: true, reason: "" } });
  await selected;
  expect(vision).not.toHaveBeenCalled();
  await ocr.activate();
  capture.select.mockResolvedValue({
    image: "selected",
    quality: { ok: true, reason: "" },
  });
  let resolveVision!: (v: string) => void;
  vision.mockImplementationOnce(
    () => new Promise((resolve) => (resolveVision = resolve)),
  );
  const pending = ocr.onShort!();
  await vi.waitFor(() => expect(vision).toHaveBeenCalled());
  ocr.cancel!();
  resolveVision("late sensitive result");
  await pending;
  expect(say).not.toHaveBeenCalledWith("late sensitive result", 1);
});
