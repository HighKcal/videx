import { vi } from "vitest";
export function device() {
  return {
    vendorId: 0x303a,
    productId: 0x1001,
    configuration: {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 2,
              interfaceSubclass: 2,
              endpoints: [],
            },
          ],
        },
        {
          interfaceNumber: 1,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 10,
              interfaceSubclass: 0,
              endpoints: [
                { direction: "in", type: "bulk", endpointNumber: 3 },
                { direction: "out", type: "bulk", endpointNumber: 4 },
              ],
            },
          ],
        },
        {
          interfaceNumber: 2,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 255,
              interfaceSubclass: 0,
              endpoints: [],
            },
          ],
        },
      ],
    },
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    selectConfiguration: vi.fn(async () => {}),
    claimInterface: vi.fn(async (_n: number) => {}),
    selectAlternateInterface: vi.fn(async () => {}),
    controlTransferOut: vi.fn(async () => ({ status: "ok" })),
    transferOut: vi.fn(async (_ep: number, bytes: Uint8Array) => ({
      status: "ok",
      bytesWritten: bytes.length,
    })),
    transferIn: vi.fn(async () => ({
      status: "ok",
      data: new DataView(Uint8Array.of(1, 2).buffer),
    })),
  };
}
export function packet(
  flags = 0,
  result = 0,
  id = 1,
  width = 320,
  height = 240,
) {
  const bytes = new Uint8Array(32),
    d = new DataView(bytes.buffer);
  bytes.set([67, 65, 77, 50, 0, flags, result, 0]);
  d.setUint32(8, id, true);
  d.setUint32(12, 4, true);
  d.setUint16(16, width, true);
  d.setUint16(18, height, true);
  d.setBigUint64(20, 123n, true);
  bytes.set([255, 216, 255, 217], 28);
  return bytes;
}
