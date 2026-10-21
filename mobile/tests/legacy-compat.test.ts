import { afterEach, expect, it, vi } from "vitest";
import { UsbFrameSource } from "../src/core/usb-source";
import { device, packet } from "./usb-fixtures";

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

it("default connection sends only requested one-byte modes, never a probe interpreted by f7f0ea4 RX", async () => {
  vi.useFakeTimers();
  const d = device();
  let receive!: (value: any) => void;
  d.transferIn.mockImplementation(() => new Promise((resolve) => { receive = resolve; }));
  const usb = { requestDevice: vi.fn(async () => d), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let initial!: Promise<void>;
  const source = new UsbFrameSource(vi.fn(), vi.fn(), (state) => {
    if (state === "CONNECTED") initial = source.resolution(0);
  }, usb);
  try {
    const opening = source.start();
    expect(usb.requestDevice).toHaveBeenCalledTimes(1);
    await opening;
    // Literal old usb_command_task: ASCII digits normalize, then bytes <=2 apply.
    const interpretedModes = () => d.transferOut.mock.calls.flatMap(([, bytes]) => Array.from(bytes).map((byte) => byte >= 48 && byte <= 50 ? byte - 48 : byte).filter((byte) => byte <= 2));
    expect(interpretedModes()).toEqual([0]);
    expect(d.transferOut.mock.calls.map(([, bytes]) => Array.from(bytes))).toEqual([[0]]);
    const send = async (bytes: Uint8Array) => {
      receive({ status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
      await flush();
    };
    await send(packet(6, 0, 1));
    await initial;
    for (const [mode, width, height] of [[1, 640, 480], [2, 1280, 1024]] as const) {
      const pending = source.resolution(mode);
      await flush();
      await send(packet(6, 0, mode + 1, width, height));
      await pending;
    }
    expect(interpretedModes()).toEqual([0, 1, 2]);
    expect(d.transferOut.mock.calls.map(([, bytes]) => Array.from(bytes))).toEqual([[0], [1], [2]]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(interpretedModes()).toEqual([0, 1, 2]);
  } finally { source.stop(); }
});
