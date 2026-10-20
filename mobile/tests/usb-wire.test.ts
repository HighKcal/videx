import { expect, it } from "vitest";
import { Cam2Parser, Cam2Buttons } from "../src/core/usb-wire";
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
