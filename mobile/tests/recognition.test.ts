import { it, expect, vi } from "vitest";
const capture = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../src/core/capture", async () => {
  const actual = await vi.importActual("../src/core/capture");
  return {
    ...actual,
    selectFrame: capture.select,
    mergeSides: vi.fn(async () => "merged"),
  };
});
import { builtInModules, type ModuleHost } from "../src/modules/builtins";
it.each(["제품명", "인식 실패"])(
  "main object manual result presentation: %s",
  async (result) => {
    const say = vi.fn(),
      error = vi.fn();
    const host = {
      ai: { vision: vi.fn(async () => result) },
      walking: {},
      frame: () => ({ width: 640, height: 480, receivedAt: performance.now() }),
      ready: () => true,
      rotation: () => "cw90",
      say,
      error,
      changed: vi.fn(),
    } as unknown as ModuleHost;
    const object = builtInModules(host)[2];
    capture.select.mockResolvedValueOnce({
      image: "front",
      quality: { ok: true, reason: "" },
    });
    capture.select.mockResolvedValueOnce({
      image: "back",
      quality: { ok: true, reason: "" },
    });
    await object.activate();
    await object.onShort!();
    await object.onShort!();
    if (result === "인식 실패")
      expect(error).toHaveBeenCalledWith("제품을 식별할 수 없습니다.");
    else expect(say).toHaveBeenCalledWith("인식된 제품은 제품명입니다.", 1);
    object.cancel?.();
  },
);
it("uses main 640x480 for OCR/object, allows empty OCR and does not time out before 45s", async () => {
  vi.useFakeTimers();
  const say = vi.fn(),
    error = vi.fn();
  let signal!: AbortSignal;
  let resolve!: (value: string) => void;
  const host = {
    ai: {
      vision: vi.fn((_image, _kind, s) => {
        signal = s;
        return new Promise<string>((done) => {
          resolve = done;
        });
      }),
    },
    walking: {},
    frame: () => ({ width: 640, height: 480, receivedAt: performance.now() }),
    ready: () => true,
    rotation: () => "cw90",
    say,
    error,
    changed: vi.fn(),
  } as unknown as ModuleHost;
  const modules = builtInModules(host);
  try {
    expect(modules[1].manifest.frame?.resolutionMode).toBe(1);
    expect(modules[2].manifest.frame?.resolutionMode).toBe(1);
    capture.select.mockResolvedValue({
      image: "selected",
      quality: { ok: true, reason: "manual" },
    });
    await modules[1].activate();
    const pending = modules[1].onShort!();
    await vi.advanceTimersByTimeAsync(44000);
    expect(signal.aborted).toBe(false);
    resolve("");
    await pending;
    expect(say).toHaveBeenCalledWith("인식된 글자가 없습니다.", 1);
    expect(error).not.toHaveBeenCalled();
  } finally {
    modules[1].cancel?.();
    vi.useRealTimers();
  }
});
it("cancels delayed image selection and delayed vision across mode/disconnect so no late upload/result", async () => {
  const say = vi.fn(),
    vision = vi.fn();
  const host = {
    ai: { vision },
    walking: {},
    frame: () => ({ width: 640, height: 480, receivedAt: performance.now() }),
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
