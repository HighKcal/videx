import { afterEach, expect, it, vi } from "vitest";
import { UsbFrameSource } from "../src/core/usb-source";
import { device, packet, controlPacket } from "./usb-fixtures";

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function harness(protocol: "legacy" | "cdc2" = "legacy") {
  const d = device();
  let receive!: (value: any) => void;
  d.transferIn.mockImplementation(() => new Promise((resolve) => { receive = resolve; }));
  const changed = vi.fn(), control = vi.fn(), frame = vi.fn();
  const source = new UsbFrameSource(frame, control, vi.fn(), {
    requestDevice: async () => d,
    addEventListener() {},
    removeEventListener() {},
  }, protocol, changed);
  return {
    source, changed, control, frame, d,
    latest: () => changed.mock.lastCall?.[0],
    send: async (...packets: Uint8Array[]) => {
      const bytes = new Uint8Array(packets.flatMap((p) => Array.from(p)));
      receive({ status: "ok", data: new DataView(bytes.buffer) });
      await flush();
    },
  };
}
afterEach(() => vi.useRealTimers());

it("distinguishes no frame, missing metadata, baseline and repeat without retaining images", async () => {
  const h = harness();
  await h.source.start();
  try {
    expect(h.latest()).toMatchObject({ availability: "no-frame", shortCount: 0, longCount: 0 });
    await h.send(packet(0, 0, 1));
    expect(h.latest()).toMatchObject({ frameId: 1, valid: false, classified: false, pressed: "unknown", decision: "no-metadata", result: 0 });
    await h.send(packet(7, 2, 2));
    expect(h.latest()).toMatchObject({ valid: true, classified: true, pressed: "pressed", decision: "baseline", result: 2, receivedAt: expect.any(Number) });
    await h.send(packet(6, 2, 3));
    expect(h.control).not.toHaveBeenCalled();
    await h.send(packet(6, 2, 4));
    expect(h.latest()).toMatchObject({ pressed: "released", decision: "repeat" });
    expect(Object.keys(h.latest()).sort()).toEqual(["availability", "classified", "decision", "frameId", "lastEvent", "longCount", "pressed", "rawFlags", "receivedAt", "result", "shortCount", "valid"].sort());
    expect(h.d.transferOut).not.toHaveBeenCalled();
  } finally { h.source.stop(); }
});

it("counts every accepted edge in coalesced reads, not just the latest displayed frame", async () => {
  const h = harness();
  await h.source.start();
  try {
    await h.send(packet(6, 0, 1), packet(7, 0, 2), packet(6, 1, 3), packet(7, 1, 4), packet(7, 2, 5), packet(6, 2, 6), packet(6, 2, 7));
    expect(h.frame).toHaveBeenCalledOnce();
    expect(h.control.mock.calls).toEqual([[{ type: "button_short" }], [{ type: "button_long" }]]);
    expect(h.latest()).toMatchObject({ frameId: 7, shortCount: 1, longCount: 1, lastEvent: { type: "button_long", at: expect.any(Number) }, decision: "repeat" });
    const accepted = h.changed.mock.calls.map(([d]) => d).filter((d) => d.decision === "accepted");
    expect(accepted.map((d) => d.frameId)).toEqual([3, 6]);
    await h.send(packet(7, 2, 7));
    expect(h.latest()).toMatchObject({ rawFlags: 7, pressed: "unknown", decision: "frame-ignored", shortCount: 1, longCount: 1 });
    await h.send(packet(6, 1, 6));
    expect(h.latest()).toMatchObject({ rawFlags: 6, pressed: "unknown", decision: "frame-ignored", shortCount: 1, longCount: 1 });
    expect(h.control).toHaveBeenCalledTimes(2);
  } finally { h.source.stop(); }
});

it("marks held state unavailable on stale/disconnect and resets session counters on reconnect", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.source.start();
  try {
    await h.send(packet(6, 0, 1), packet(7, 0, 2), packet(6, 1, 3), packet(7, 1, 4));
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.latest()).toMatchObject({ availability: "stale", pressed: "unknown", shortCount: 1 });
    await h.send(packet(7, 1, 5));
    expect(h.latest()).toMatchObject({ availability: "live", decision: "baseline" });
    await h.send(packet(6, 1, 6));
    expect(h.control).toHaveBeenCalledOnce();
    h.source.stop();
    expect(h.latest()).toMatchObject({ availability: "disconnected", pressed: "unknown" });
    await h.source.start();
    expect(h.latest()).toMatchObject({ availability: "no-frame", shortCount: 0, longCount: 0, frameId: null, lastEvent: null });
  } finally { h.source.stop(); }
});

it("ignores secondary camera metadata and counts only accepted USB2 event IDs when explicitly enabled", async () => {
  const h = harness("cdc2");
  await h.source.start();
  try {
    await h.send(controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }));
    const secondary = packet();
    secondary[4] = 1;
    await h.send(secondary);
    expect(h.latest()).toMatchObject({ availability: "no-frame" });
    await h.send(controlPacket({ type: "button_short", epoch: 7, event_id: 1 }), controlPacket({ type: "button_short", epoch: 7, event_id: 1 }));
    expect(h.latest()).toMatchObject({ shortCount: 1, longCount: 0, lastEvent: { type: "button_short" } });
    expect(h.control).toHaveBeenCalledOnce();
  } finally { h.source.stop(); }
});
