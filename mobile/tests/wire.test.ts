import { describe, it, expect } from "vitest";
import { parseFrame, LatestQueue } from "../src/core/wire";
import { packet } from "./fixtures";
describe("wire", () => {
  it("parses exact nested headers without comparing remote clocks", () => {
    const f = parseFrame(packet(), 10);
    expect(f.epoch).toBe(7);
    expect(f.width).toBe(320);
    expect(f.receivedAt).toBe(10);
  });
  it("rejects wrong camera, lengths and versions", () => {
    for (const offset of [4, 6, 28, 36, 40, 52]) {
      const a = packet();
      new Uint8Array(a)[offset] ^= 3;
      expect(() => parseFrame(a, 0)).toThrow();
    }
  });
  it("retains only latest bounded frames", () => {
    const q = new LatestQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.take()).toBe(3);
    expect(q.take()).toBeUndefined();
  });
});
