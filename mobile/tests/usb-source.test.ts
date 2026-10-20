import { afterEach, expect, it, vi } from "vitest";
import { UsbFrameSource } from "../src/core/usb-source";
import { device, packet } from "./usb-fixtures";
function harness(profile: "legacy" | "v2-mirror" = "legacy") {
  const d = device();
  let receive: (value: any) => void = () => {};
  d.transferIn.mockImplementation(
    () =>
      new Promise((resolve) => {
        receive = resolve;
      }),
  );
  const usb = {
    requestDevice: vi.fn(async () => d),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const frame = vi.fn(),
    control = vi.fn(),
    state = vi.fn();
  const source = new UsbFrameSource(profile, frame, control, state, usb as any);
  const send = async (bytes: Uint8Array) => {
    receive({
      status: "ok",
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    await flush();
  };
  return { d, usb, frame, control, state, source, send };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
it("opens from a gesture immediately, streams locally, verifies mode by subsequent dimensions and dispatches buttons", async () => {
  const h = harness();
  const start = h.source.start();
  expect(h.usb.requestDevice).toHaveBeenCalledTimes(1);
  await start;
  const resolution = h.source.resolution(2),
    done = vi.fn();
  void resolution.then(done);
  await flush();
  expect(h.d.transferOut).toHaveBeenCalledWith(4, Uint8Array.of(2));
  await h.send(packet(6, 0, 1));
  expect(done).not.toHaveBeenCalled();
  await h.send(packet(7, 0, 2, 1280, 1024));
  await resolution;
  expect(done).toHaveBeenCalled();
  await h.send(packet(6, 1, 3, 1280, 1024));
  expect(h.control).toHaveBeenCalledWith({ type: "button_short" });
  expect(h.frame.mock.lastCall![0]).toMatchObject({
    width: 1280,
    frameId: 3,
    sequence: 3,
    s3Us: 0n,
  });
  await h.send(packet(6, 1, 3));
  expect(h.frame).toHaveBeenCalledTimes(3);
  h.source.stop();
  await flush();
  expect(h.d.close).toHaveBeenCalled();
});
it("v2 mirror does not pretend USB mode commands or physical buttons exist", async () => {
  const h = harness("v2-mirror");
  await h.source.start();
  const mode = h.source.resolution(0);
  await h.send(packet());
  await mode;
  await expect(h.source.resolution(2)).rejects.toThrow(/읽기 전용/);
  expect(h.d.transferOut).not.toHaveBeenCalled();
  await h.send(packet(7, 0, 2));
  await h.send(packet(6, 1, 3));
  expect(h.control).not.toHaveBeenCalled();
  h.source.stop();
});
it("stales even before first frame, recovers, rejects mode timeout, and invalidates unplug", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  await vi.advanceTimersByTimeAsync(2500);
  expect(h.state.mock.lastCall![0]).toMatch(/UNKNOWN.*영상/);
  await h.send(packet());
  expect(h.state.mock.lastCall![0]).toBe("CONNECTED");
  const pending = h.source.resolution(2);
  const failed = expect(pending).rejects.toThrow(/시간 초과/);
  await vi.advanceTimersByTimeAsync(6500);
  await failed;
  const next = h.source.resolution(0);
  const stopped = expect(next).rejects.toThrow();
  h.usb.addEventListener.mock.calls[0][1]({ device: h.d });
  await stopped;
  expect(h.state.mock.lastCall![0]).toMatch(/UNKNOWN.*분리/);
  expect(h.usb.removeEventListener).toHaveBeenCalled();
});
it("reports unsupported, cancelled chooser and kernel claim errors without retries", async () => {
  const state = vi.fn();
  const s = new UsbFrameSource("legacy", vi.fn(), vi.fn(), state, undefined);
  await s.start();
  expect(state.mock.lastCall![0]).toMatch(/WebUSB/);
  const h = harness();
  h.usb.requestDevice.mockRejectedValueOnce(
    new DOMException("cancelled", "NotFoundError"),
  );
  await h.source.start();
  expect(h.state.mock.lastCall![0]).toMatch(/취소/);
  const k = harness();
  k.d.claimInterface.mockRejectedValueOnce(new Error("busy"));
  await k.source.start();
  expect(k.state.mock.lastCall![0]).toMatch(/드라이버/);
  expect(k.d.close).toHaveBeenCalled();
});
it("stale buffered bytes cannot revive old images or button events", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  const incomplete = packet();
  new DataView(incomplete.buffer).setUint32(12, 500, true);
  await h.send(new Uint8Array([...incomplete, ...packet(6, 0, 2)]));
  await vi.advanceTimersByTimeAsync(7000);
  expect(h.frame).not.toHaveBeenCalled();
  expect(h.state.mock.lastCall![0]).toMatch(/UNKNOWN/);
  h.source.stop();
});
it("read failure rejects mode request, while stop during open closes without CONNECTED", async () => {
  const h = harness();
  h.d.transferIn.mockRejectedValueOnce(Error("unplug"));
  await h.source.start();
  await flush();
  expect(h.state.mock.lastCall![0]).toMatch(/읽기 실패/);
  const k = harness();
  let opened!: () => void;
  k.d.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  const start = k.source.start();
  await flush();
  k.source.stop();
  opened();
  await start;
  expect(k.state.mock.calls.some(([s]) => s === "CONNECTED")).toBe(false);
  expect(k.d.close).toHaveBeenCalled();
});
it("stop during chooser cannot reopen or deliver frames", async () => {
  const h = harness();
  let choose!: (d: any) => void;
  h.usb.requestDevice.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
  );
  const start = h.source.start();
  h.source.stop();
  choose(h.d);
  await start;
  expect(h.d.open).not.toHaveBeenCalled();
  expect(h.frame).not.toHaveBeenCalled();
});
