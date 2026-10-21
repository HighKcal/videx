import { afterEach, expect, it, vi } from "vitest";
import { PreviewRenderer } from "../src/core/preview-renderer";
import { frame } from "./frame-fixture";
import type { Rotation } from "../src/core/orientation";

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function harness() {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const status = vi.fn();
  const painter = new PreviewRenderer();
  painter.attach(canvas as any, status);
  return { ctx, canvas, status, painter };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps one decode in flight and replaces its single pending frame with the latest", async () => {
  const completions: Array<(value: any) => void> = [];
  const decode = vi.fn(
    () => new Promise((resolve) => completions.push(resolve)),
  );
  vi.stubGlobal("createImageBitmap", decode);
  const h = harness();
  const input = {
    connection: "CONNECTED",
    version: 1,
    rotation: "none" as const,
  };
  const first = frame();
  h.painter.update({ ...input, frame: first });
  for (let i = 2; i <= 100; i++)
    h.painter.update({ ...input, frame: frame(7, i) });
  expect(decode).toHaveBeenCalledOnce();
  const bitmap = { width: 320, height: 240, close: vi.fn() };
  completions.shift()!(bitmap);
  await flush();
  expect(decode).toHaveBeenCalledTimes(2);
  completions.shift()!(bitmap);
  await flush();
  expect(h.status.mock.lastCall?.[0]).toMatchObject({
    kind: "live",
    frameId: 100,
  });
  expect(bitmap.close).toHaveBeenCalledTimes(2);
  h.painter.detach();
});

it.each([
  "mode",
  "session",
  "rotation",
  "stale",
  "disconnect",
  "hide",
  "hide-reopen",
])("does not paint a late decode after %s", async (change) => {
  let complete!: (bitmap: any) => void;
  const decode = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("createImageBitmap", decode);
  const h = harness();
  const input = {
    connection: "CONNECTED",
    version: 1,
    rotation: "none" as const,
    frame: frame(),
  };
  h.painter.update(input);
  if (change === "mode")
    h.painter.update({ ...input, version: 2, frame: undefined });
  if (change === "session") h.painter.update({ ...input, frame: frame(8) });
  if (change === "rotation") h.painter.update({ ...input, rotation: "cw90" });
  if (change === "stale")
    h.painter.update({
      ...input,
      connection: "UNKNOWN · USB 영상 지연",
      frame: undefined,
    });
  if (change === "disconnect")
    h.painter.update({
      ...input,
      connection: "DISCONNECTED",
      frame: undefined,
    });
  if (change.startsWith("hide")) h.painter.detach();
  if (change === "hide-reopen") {
    h.painter.attach(h.canvas as any, h.status);
    h.painter.update(input);
  }
  expect([h.canvas.width, h.canvas.height]).toEqual([0, 0]);
  expect(decode).toHaveBeenCalledOnce();
  const bitmap = { width: 320, height: 240, close: vi.fn() };
  complete(bitmap);
  await flush();
  expect(h.ctx.drawImage).not.toHaveBeenCalled();
  expect(bitmap.close).toHaveBeenCalledOnce();
  h.painter.detach();
});

it("clears a drawn image on age expiry even without a source notification and never decodes stale input", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const bitmap = { width: 320, height: 240, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const h = harness();
  const input = {
    connection: "CONNECTED",
    version: 1,
    rotation: "none" as const,
    frame: frame(7, 1, now),
  };
  h.painter.update(input);
  await flush();
  expect(h.canvas.width).toBe(320);
  now = 2101;
  h.painter.update(input);
  expect([h.canvas.width, h.canvas.height]).toEqual([0, 0]);
  expect(h.status.mock.lastCall?.[0]).toEqual({ kind: "stale" });
  expect(decode).toHaveBeenCalledOnce();
  h.painter.detach();
});

it("does not paint a frame that ages out while decoding", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let complete!: (bitmap: any) => void;
  vi.stubGlobal(
    "createImageBitmap",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const h = harness();
  h.painter.update({
    connection: "CONNECTED",
    version: 1,
    rotation: "none",
    frame: frame(7, 1, now),
  });
  now = 2101;
  const bitmap = { width: 320, height: 240, close: vi.fn() };
  complete(bitmap);
  await flush();
  expect(h.ctx.drawImage).not.toHaveBeenCalled();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(h.status.mock.lastCall?.[0]).toEqual({ kind: "stale" });
  h.painter.detach();
});

it.each(["bad-jpeg", "wrong-dimensions"])(
  "clears instead of presenting a frozen live image after %s",
  async (fault) => {
    const bitmap = { width: 640, height: 480, close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      fault === "bad-jpeg"
        ? vi.fn(async () => {
            throw Error("bad JPEG");
          })
        : vi.fn(async () => bitmap),
    );
    const h = harness();
    h.painter.update({
      connection: "CONNECTED",
      version: 1,
      rotation: "none",
      frame: frame(),
    });
    await flush();
    expect(h.ctx.drawImage).not.toHaveBeenCalled();
    expect(h.status.mock.lastCall?.[0]).toEqual({ kind: "error" });
    expect([h.canvas.width, h.canvas.height]).toEqual([0, 0]);
    if (fault === "wrong-dimensions")
      expect(bitmap.close).toHaveBeenCalledOnce();
    h.painter.detach();
  },
);

it.each(["none", "cw90", "ccw90", "180"] as Rotation[])(
  "draws native pixels with the recognition orientation %s and closes its bitmap",
  async (rotation) => {
    const bitmap = { width: 320, height: 240, close: vi.fn() };
    const decode = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const h = harness();
    try {
      h.painter.update({
        connection: "CONNECTED",
        version: 1,
        rotation,
        frame: frame(),
      });
      await flush();
      expect(decode).toHaveBeenCalledOnce();
      expect([h.canvas.width, h.canvas.height]).toEqual(
        rotation.endsWith("90") ? [240, 320] : [320, 240],
      );
      expect(h.ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 320, 240);
      if (rotation === "cw90")
        expect(h.ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
      if (rotation === "ccw90")
        expect(h.ctx.rotate).toHaveBeenCalledWith(-Math.PI / 2);
      if (rotation === "180")
        expect(h.ctx.rotate).toHaveBeenCalledWith(Math.PI);
      expect(h.status.mock.lastCall?.[0]).toMatchObject({
        kind: "live",
        frameId: 1,
        width: 320,
        height: 240,
      });
      expect(bitmap.close).toHaveBeenCalledOnce();
    } finally {
      h.painter.detach();
    }
  },
);
