import { expect, it, vi } from "vitest";
import { Cam2Parser, Cam2Buttons, encodeCommand } from "../src/core/usb-wire";
it("bounds garbage and resynchronizes invalid headers, JPEGs and timed-out partial frames", () => {
  const p = new Cam2Parser(),
    frames: any[] = [],
    emit = (f: any) => frames.push(f);
  p.feed(new Uint8Array(3 * 1048576), 0, emit);
  expect(p.bufferedBytes).toBeLessThan(4);
  const bad = packet();
  new DataView(bad.buffer).setUint32(12, 0xffffffff, true);
  p.feed(new Uint8Array([...bad, ...packet()]), 1, emit);
  const jpeg = packet();
  jpeg[31] = 0;
  p.feed(new Uint8Array([...jpeg, ...packet()]), 2, emit);
  const incomplete = packet();
  new DataView(incomplete.buffer).setUint32(12, 500, true);
  p.feed(incomplete, 3, emit);
  p.feed(packet(), 6004, emit);
  expect(frames).toHaveLength(3);
});
it("only emits classified release after an observed press, resets on gaps; raw levels use host duration", () => {
  const buttons = new Cam2Buttons(),
    p = new Cam2Parser();
  const observe = (flags: number, result: number, now: number) => {
    let event;
    p.feed(
      packet(flags, result),
      now,
      (f) => (event = buttons.observe(f, now)),
    );
    return event;
  };
  expect(observe(7, 2, 0)).toBeUndefined();
  expect(observe(6, 2, 100)).toBeUndefined();
  observe(7, 2, 200);
  expect(observe(6, 1, 300)).toBe("button_short");
  expect(observe(6, 1, 400)).toBeUndefined();
  observe(7, 1, 500);
  expect(observe(6, 1, 600)).toBe("button_short");
  observe(7, 1, 700);
  expect(observe(6, 2, 3000)).toBeUndefined();
  observe(3, 0, 3100);
  expect(observe(2, 0, 4200)).toBe("button_long");
  observe(3, 0, 4300);
  observe(0, 0, 4400);
  expect(observe(2, 0, 4500)).toBeUndefined();
});
import { packet } from "./usb-fixtures";
it("parses fragmented and coalesced actual CAM2 USB envelopes without a WSS header", () => {
  const p = new Cam2Parser(),
    frames: any[] = [];
  const a = packet();
  for (const b of a) p.feed(Uint8Array.of(b), 10, (f) => frames.push(f));
  p.feed(new Uint8Array([...a, ...a]), 20, (f) => frames.push(f));
  expect(frames).toHaveLength(3);
  expect(frames[0]).toMatchObject({
    cameraId: 0,
    frameId: 1,
    width: 320,
    height: 240,
    cameraUs: 123n,
  });
  expect([...frames[0].jpeg]).toEqual([255, 216, 255, 217]);
});

import { controlPacket } from "./usb-fixtures";
it("parses fragmented mixed controls without interpreting JPEG payload as controls", () => {
  const p = new Cam2Parser(),
    frames: any[] = [],
    controls: any[] = [];
  const bytes = new Uint8Array([
    ...packet(),
    ...controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
    ...packet(),
  ]);
  for (const byte of bytes)
    p.feed(
      Uint8Array.of(byte),
      0,
      (f) => frames.push(f),
      (c) => controls.push(c),
    );
  expect(frames).toHaveLength(2);
  expect(controls).toEqual([
    { epoch: 7, value: { type: "connected", epoch: 7, protocol: "cdc2" } },
  ]);
  expect(encodeCommand({ type: "hello" }, 0)).toEqual(
    controlPacket({ type: "hello" }, 0, 1),
  );
});

it.each([
  "version",
  "kind",
  "reserved",
  "length",
  "epoch",
  "json",
  "duplicate",
  "utf8",
  "partial",
])(
  "rejects malformed USB2 %s instead of interpreting bytes as CAM2",
  (fault) => {
    const p = new Cam2Parser();
    let bytes = controlPacket({
      type: "heartbeat",
      epoch: 7,
      camera_online: true,
      button_online: true,
    });
    if (fault === "version") bytes[4] = 2;
    if (fault === "kind") bytes[5] = 1;
    if (fault === "reserved") bytes[6] = 1;
    if (fault === "length") new DataView(bytes.buffer).setUint32(8, 256, true);
    if (fault === "epoch") new DataView(bytes.buffer).setUint32(12, 0, true);
    if (fault === "json") bytes[16] = 0;
    if (fault === "utf8") bytes[16] = 255;
    if (fault === "duplicate") {
      const raw = new TextEncoder().encode(
        `{"type":"heartbeat","type":"disconnected"}`,
      );
      bytes = new Uint8Array(16 + raw.length);
      bytes.set(controlPacket({}, 7).subarray(0, 16));
      new DataView(bytes.buffer).setUint32(8, raw.length, true);
      bytes.set(raw, 16);
    }
    if (fault === "partial") {
      p.feed(bytes.subarray(0, 8), 0, () => {});
      expect(() => p.feed(new Uint8Array(), 500, () => {})).toThrow();
    } else expect(() => p.feed(bytes, 0, () => {})).toThrow();
  },
);
it("bounds garbage between mixed records and never scans inside a complete JPEG", () => {
  const p = new Cam2Parser(),
    controls = vi.fn(),
    frames = vi.fn();
  const hidden = controlPacket({ type: "button_short", epoch: 7, event_id: 1 });
  const jpeg = new Uint8Array(32 + hidden.length);
  jpeg.set(packet().subarray(0, 30));
  jpeg.set(hidden, 30);
  jpeg.set([255, 217], jpeg.length - 2);
  new DataView(jpeg.buffer).setUint32(12, jpeg.length - 28, true);
  p.feed(
    new Uint8Array([
      ...jpeg,
      ...new Uint8Array(100),
      ...controlPacket({ type: "connected", epoch: 7, protocol: "cdc2" }),
    ]),
    0,
    frames,
    controls,
  );
  expect(frames).toHaveBeenCalledOnce();
  expect(controls).toHaveBeenCalledOnce();
  expect(p.bufferedBytes).toBeLessThan(4);
});

it.each([
  [{ type: "hello", extra: true }, 0],
  [{ type: "ping", extra: true }, 7],
  [{ type: "unknown" }, 7],
  [{ type: "hello" }, 7],
  [{ type: "ping" }, 0],
  [{ type: "ping" }, 1.5],
  [{ type: "resolution", request_id: "bad id", mode: 0 }, 7],
  [{ type: "resolution", request_id: "r", mode: 3 }, 7],
  [{ type: "resolution", request_id: "r".repeat(65), mode: 0 }, 7],
])("rejects invalid framed commands %j", (value, epoch) => {
  expect(() => encodeCommand(value as any, epoch as number)).toThrow();
});
