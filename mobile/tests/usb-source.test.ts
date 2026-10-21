import { afterEach, expect, it, vi } from "vitest";
import { UsbFrameSource } from "../src/core/usb-source";
import { device, packet, controlPacket, commandValue } from "./usb-fixtures";
function harness(protocol: "legacy" | "cdc2" = "legacy") {
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
  const source = new UsbFrameSource(frame, control, state, usb as any, protocol);
  const send = async (bytes: Uint8Array) => {
    receive({
      status: "ok",
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    await flush();
  };
  return {
    d,
    usb,
    frame,
    control,
    state,
    source,
    send,
    readCompletion: () => receive,
  };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
it("default connects immediately without writes or delayed binary probes", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  expect(h.state.mock.lastCall![0]).toBe("CONNECTED");
  expect(h.d.transferOut).not.toHaveBeenCalled();
  await h.send(packet(6, 2, 1));
  await vi.advanceTimersByTimeAsync(1500);
  expect(h.d.transferOut).not.toHaveBeenCalled();
  expect(h.control).not.toHaveBeenCalled();
  h.source.stop();
});
it("legacy persistent results emit once per release, including SHORT to SHORT and LONG to SHORT", async () => {
  const h = harness();
  await h.source.start();
  let id = 0;
  const send = (flags: number, result: number) =>
    h.send(packet(flags, result, ++id));
  await send(6, 2);
  let previous = 2;
  for (const result of [1, 1, 2, 1]) {
    await send(7, previous); // LAST result persists throughout the next press.
    await send(7, result === 2 ? 2 : previous);
    await send(6, result);
    await send(6, result);
    previous = result;
  }
  expect(h.control.mock.calls).toEqual([
    [{ type: "button_short" }],
    [{ type: "button_short" }],
    [{ type: "button_long" }],
    [{ type: "button_short" }],
  ]);
  h.source.stop();
});
it("legacy reconnect and stale recovery baseline a held button without replaying its release", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  await h.send(packet(6, 1, 1));
  await h.send(packet(7, 1, 2));
  const oldReceive = h.readCompletion();
  h.source.stop();
  await h.source.start();
  oldReceive({ status: "ok", data: new DataView(packet(6, 2, 3).buffer) });
  await flush();
  await h.send(packet(7, 2, 1));
  await h.send(packet(6, 2, 2));
  expect(h.control).not.toHaveBeenCalled();
  await h.send(packet(7, 2, 3));
  await vi.advanceTimersByTimeAsync(2500);
  await h.send(packet(6, 1, 4));
  expect(h.control).not.toHaveBeenCalled();
  await h.send(packet(7, 1, 5));
  await h.send(packet(6, 1, 6));
  expect(h.control.mock.calls).toEqual([[{ type: "button_short" }]]);
  expect(h.d.transferOut).not.toHaveBeenCalled();
  h.source.stop();
});
it("legacy raw levels classify short and long only on release", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  await h.send(packet(2, 0, 1));
  await h.send(packet(3, 0, 2));
  await vi.advanceTimersByTimeAsync(999);
  await h.send(packet(2, 0, 3));
  await h.send(packet(3, 0, 4));
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.control.mock.calls).toEqual([[{ type: "button_short" }]]);
  await h.send(packet(2, 0, 5));
  await h.send(packet(2, 0, 6));
  expect(h.control.mock.calls).toEqual([
    [{ type: "button_short" }],
    [{ type: "button_long" }],
  ]);
  h.source.stop();
});
it("opens from a gesture immediately, streams locally, verifies mode by subsequent dimensions and dispatches buttons", async () => {
  vi.useFakeTimers();
  const h = harness();
  const start = h.source.start();
  expect(h.usb.requestDevice).toHaveBeenCalledTimes(1);
  await start;
  await vi.advanceTimersByTimeAsync(1500);
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
  const s = new UsbFrameSource(vi.fn(), vi.fn(), state, undefined);
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

it("negotiates once, queues mode, and exclusively dispatches independent session events without JPEG", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  expect(commandValue(h.d.transferOut.mock.calls[0][1])).toEqual({
    type: "hello",
  });
  const pending = h.source.resolution(1);
  const failed = pending.catch(() => {});
  await flush();
  expect(h.d.transferOut).toHaveBeenCalledTimes(1);
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  expect(commandValue(h.d.transferOut.mock.lastCall![1])).toMatchObject({
    type: "resolution",
    mode: 1,
  });
  await h.send(controlPacket({ type: "button_long", epoch: 7, event_id: 1 }));
  await h.send(controlPacket({ type: "button_long", epoch: 7, event_id: 1 }));
  await h.send(packet(6, 0, 1));
  await h.send(packet(7, 0, 2));
  await h.send(packet(6, 1, 3));
  expect(h.control.mock.calls).toEqual([[{ type: "button_long" }]]);
  h.source.stop();
  await failed;
});

it("requires correlated resolution ACK plus host-observed dimensions, never raw commands in cdc2", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  const done = vi.fn(),
    pending = h.source.resolution(2);
  void pending.then(done);
  const request = commandValue(h.d.transferOut.mock.lastCall![1]);
  await h.send(packet(0, 0, 1, 1280, 1024));
  expect(done).not.toHaveBeenCalled();
  await h.send(
    controlPacket({
      type: "resolution_applied",
      request_id: "other",
      mode: 2,
      width: 1280,
      height: 1024,
      reason: "observed",
    }),
  );
  expect(done).not.toHaveBeenCalled();
  await h.send(
    controlPacket({
      type: "resolution_applied",
      request_id: request.request_id,
      mode: 2,
      width: 1280,
      height: 1024,
      reason: "observed",
    }),
  );
  await pending;
  expect(done).toHaveBeenCalledOnce();
  const again = h.source.resolution(1),
    failed = again.catch(() => {});
  const second = commandValue(h.d.transferOut.mock.lastCall![1]);
  await h.send(
    controlPacket({
      type: "resolution_applied",
      request_id: second.request_id,
      mode: 1,
      width: 640,
      height: 480,
      reason: "observed",
    }),
  );
  const complete = vi.fn();
  void again.then(complete, () => {});
  await flush();
  expect(complete).not.toHaveBeenCalled();
  await h.send(packet(0, 0, 2, 640, 480));
  await again;
  expect(h.d.transferOut.mock.calls.every(([, b]) => b.length > 16)).toBe(true);
  h.source.stop();
  await failed;
});
it("sends ping within one second and fails closed after a missing heartbeat without fallback", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(commandValue(h.d.transferOut.mock.lastCall![1])).toEqual({
    type: "ping",
  });
  await h.send(
    controlPacket({
      type: "heartbeat",
      epoch: 7,
      camera_online: false,
      button_online: true,
    }),
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.d.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.d.close).toHaveBeenCalled();
  const calls = h.control.mock.calls.length;
  await h.send(packet(6, 1, 5));
  expect(h.control).toHaveBeenCalledTimes(calls);
  await expect(h.source.resolution(0)).rejects.toThrow();
});

it("starts heartbeat cadence at negotiation, even between watcher ticks", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await vi.advanceTimersByTimeAsync(400);
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(commandValue(h.d.transferOut.mock.lastCall![1])).toEqual({
    type: "ping",
  });
  h.source.stop();
});
it("discards pre-connected latest image when connected changes epoch within a coalesced read", async () => {
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    new Uint8Array([
      ...packet(0, 0, 500),
      ...controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
    ]),
  );
  expect(h.frame).not.toHaveBeenCalled();
  await h.send(new Uint8Array([...packet(0, 0, 1), ...packet(0, 0, 2)]));
  expect(h.frame).toHaveBeenCalledOnce();
  expect(h.frame.mock.lastCall![0]).toMatchObject({ frameId: 2, sequence: 2 });
  h.source.stop();
});
it.each([
  { type: "button_short", epoch: 8, event_id: 1 },
  { type: "button_short", epoch: 7, event_id: 0 },
  { type: "button_short", epoch: 7, event_id: 1.5 },
  { type: "button_short", epoch: 7, event_id: 4294967296 },
  { type: "button_short", epoch: 7, event_id: 1, extra: true },
  { type: "heartbeat", epoch: 7, camera_online: 1, button_online: true },
  { type: "connected", epoch: 7, protocol: "cdc2" },
  { type: "disconnected", reason: "button_disconnected" },
  { type: "unknown" },
])("fails closed for invalid/session-fault controls %j", async (value) => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await h.send(controlPacket(value));
  expect(h.d.close).toHaveBeenCalled();
  expect(h.control).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.d.transferOut.mock.calls.every(([, b]) => b.length > 16)).toBe(true);
});
it("explicit cdc2 fallback waits the full hello window and flushes only the newest queued mode", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  const a = h.source.resolution(1),
    cancelled = expect(a).rejects.toThrow();
  const b = h.source.resolution(2),
    done = vi.fn();
  void b.then(done);
  await vi.advanceTimersByTimeAsync(1499);
  expect(h.d.transferOut).toHaveBeenCalledTimes(1);
  await h.send(packet(6, 0, 1));
  await h.send(packet(7, 0, 2));
  await h.send(packet(6, 1, 3));
  expect(h.control).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.d.transferOut.mock.lastCall![1]).toEqual(Uint8Array.of(2));
  await h.send(packet(0, 0, 4, 1280, 1024));
  await b;
  await cancelled;
  h.source.stop();
});
it("rejects stale header epochs and suppresses old read completion across reconnect", async () => {
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await h.send(packet());
  const oldEpoch = h.frame.mock.lastCall![0].epoch;
  const oldReceive = h.readCompletion();
  h.source.stop();
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 8, protocol: "cdc2" }, 8),
  );
  const old = packet(0, 0, 99);
  oldReceive({ status: "ok", data: new DataView(old.buffer) });
  await flush();
  expect(h.frame).toHaveBeenCalledOnce();
  await h.send(packet());
  expect(h.frame.mock.lastCall![0].epoch).not.toBe(oldEpoch);
  await h.send(
    controlPacket({ type: "button_short", epoch: 7, event_id: 1 }, 7),
  );
  expect(h.d.close).toHaveBeenCalled();
  h.source.stop();
});

it("long is delivered once while held; release flags and duplicate/out-of-order event IDs cannot emit short", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await h.send(packet(6, 0, 1));
  await h.send(packet(7, 0, 2));
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.control).not.toHaveBeenCalled();
  await h.send(controlPacket({ type: "button_long", epoch: 7, event_id: 2 }));
  expect(h.control.mock.calls).toEqual([[{ type: "button_long" }]]);
  await h.send(packet(7, 2, 3));
  await h.send(packet(6, 2, 4));
  await h.send(controlPacket({ type: "button_short", epoch: 7, event_id: 1 }));
  await h.send(controlPacket({ type: "button_short", epoch: 7, event_id: 2 }));
  expect(h.control).toHaveBeenCalledOnce();
  await h.send(controlPacket({ type: "button_short", epoch: 7, event_id: 3 }));
  expect(h.control).toHaveBeenCalledTimes(2);
  h.source.stop();
});
it("late read and command write rejection from a stopped generation cannot affect a new session", async () => {
  const h = harness("cdc2");
  await h.source.start();
  let reject!: (e: Error) => void;
  h.d.transferOut.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  const p = h.source.resolution(2),
    failed = p.catch(() => {});
  h.source.stop();
  await failed;
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 8, protocol: "cdc2" }, 8),
  );
  reject(Error("old write failure"));
  await flush();
  await h.send(
    controlPacket({ type: "button_short", epoch: 8, event_id: 1 }, 8),
  );
  expect(h.control).toHaveBeenCalledOnce();
  expect(h.state.mock.lastCall![0]).toBe("CONNECTED");
  h.source.stop();
});

it.each([
  {
    type: "resolution_applied",
    request_id: "bad id",
    mode: 0,
    width: 320,
    height: 240,
    reason: "observed",
  },
  {
    type: "resolution_failed",
    request_id: "r1",
    mode: 0,
    width: 0,
    height: 0,
    reason: "made_up",
  },
  {
    type: "resolution_applied",
    request_id: "r1",
    mode: 0,
    width: 640,
    height: 480,
    reason: "observed",
  },
])("fails closed for malformed resolution controls %j", async (value) => {
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  await h.send(controlPacket(value));
  expect(h.d.close).toHaveBeenCalled();
  h.source.stop();
});

it("reconnect resets negotiation before asynchronous USB open so a mode cannot leak as raw", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await vi.advanceTimersByTimeAsync(1500);
  h.source.stop();
  let opened!: () => void;
  h.d.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        opened = resolve;
      }),
  );
  const start = h.source.start();
  await flush();
  const writes = h.d.transferOut.mock.calls.length;
  const request = h.source.resolution(1),
    failed = request.catch(() => {});
  await flush();
  expect(h.d.transferOut).toHaveBeenCalledTimes(writes);
  opened();
  await start;
  expect(commandValue(h.d.transferOut.mock.lastCall![1])).toEqual({
    type: "hello",
  });
  h.source.stop();
  await failed;
});

it("correlates a negative resolution ACK and rejects only its pending request", async () => {
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  const promise = h.source.resolution(2),
    failed = expect(promise).rejects.toThrow(/camera_unavailable/);
  const request = commandValue(h.d.transferOut.mock.lastCall![1]);
  await h.send(
    controlPacket({
      type: "resolution_failed",
      request_id: request.request_id,
      mode: 2,
      width: 0,
      height: 0,
      reason: "camera_unavailable",
    }),
  );
  await failed;
  expect(h.d.close).not.toHaveBeenCalled();
  h.source.stop();
});
it("malformed extension header fails negotiation instead of enabling a timed fallback", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  const bad = controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" });
  bad[4] = 9;
  await h.send(bad);
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.d.close).toHaveBeenCalled();
  expect(h.state.mock.calls.some(([s]) => s === "CONNECTED")).toBe(false);
});
it("ignores invalid JPEG, paused secondary camera, duplicates and regressive frame IDs", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  await vi.advanceTimersByTimeAsync(1500);
  const invalid = packet(7, 0, 1);
  invalid[31] = 0;
  await h.send(invalid);
  const paused = new Uint8Array(28);
  paused.set([67, 65, 77, 50, 1, 8, 0, 0]);
  await h.send(paused);
  await h.send(packet(6, 0, 10));
  await h.send(packet(7, 0, 10));
  await h.send(packet(7, 0, 9));
  expect(h.frame).toHaveBeenCalledOnce();
  expect(h.control).not.toHaveBeenCalled();
  h.source.stop();
});

it("a stalled cdc2 frame cannot be revived by completing its stale buffered bytes", async () => {
  vi.useFakeTimers();
  const h = harness("cdc2");
  await h.source.start();
  await h.send(
    controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
  );
  const bytes = packet();
  await h.send(bytes.subarray(0, 30));
  await vi.advanceTimersByTimeAsync(2500);
  await h.send(bytes.subarray(30));
  expect(h.frame).not.toHaveBeenCalled();
  expect(h.d.close).toHaveBeenCalled();
  h.source.stop();
});
