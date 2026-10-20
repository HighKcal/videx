export interface Frame {
  epoch: number;
  sequence: number;
  frameId: number;
  width: number;
  height: number;
  cameraUs: bigint;
  s3Us: bigint;
  receivedAt: number;
  jpeg: Uint8Array<ArrayBuffer>;
}
export function parseFrame(buffer: ArrayBuffer, receivedAt: number): Frame {
  const a = new Uint8Array(buffer),
    d = new DataView(buffer);
  const magic = (i: number, s: string) =>
    s.split("").every((c, k) => a[i + k] === c.charCodeAt(0));
  if (
    a.length < 56 ||
    !magic(0, "VDX2") ||
    d.getUint16(4, true) !== 1 ||
    d.getUint16(6, true) !== 52 ||
    !magic(24, "CAM2") ||
    a[28] !== 0
  )
    throw Error("Invalid frame envelope");
  const size = d.getUint32(36, true),
    width = d.getUint16(40, true),
    height = d.getUint16(42, true);
  if (
    size < 4 ||
    size > 1048576 ||
    a.length !== 52 + size ||
    ![
      [320, 240],
      [640, 480],
      [1280, 1024],
    ].some(([w, h]) => w === width && h === height) ||
    a[52] !== 255 ||
    a[53] !== 216 ||
    a[a.length - 2] !== 255 ||
    a[a.length - 1] !== 217
  )
    throw Error("Invalid JPEG or dimensions");
  return {
    epoch: d.getUint32(8, true),
    sequence: d.getUint32(12, true),
    frameId: d.getUint32(32, true),
    width,
    height,
    cameraUs: d.getBigUint64(44, true),
    s3Us: d.getBigUint64(16, true),
    receivedAt,
    jpeg: a.slice(52),
  };
}
export class LatestQueue<T> {
  private latest?: T;
  push(item: T) {
    this.latest = item;
  }
  take() {
    const item = this.latest;
    this.latest = undefined;
    return item;
  }
  clear() {
    this.latest = undefined;
  }
}
