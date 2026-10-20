export interface Cam2Frame {
  cameraId: number;
  flags: number;
  result: number;
  paused: boolean;
  frameId: number;
  width: number;
  height: number;
  cameraUs: bigint;
  jpeg: Uint8Array<ArrayBuffer>;
}
// Legacy metadata is a repeated LAST result, not an event counter.
export class Cam2Buttons {
  private pressed?: boolean;
  private downAt?: number;
  private lastAt?: number;
  reset() {
    this.pressed = undefined;
    this.downAt = undefined;
    this.lastAt = undefined;
  }
  observe(
    frame: Cam2Frame,
    now: number,
  ): "button_short" | "button_long" | undefined {
    if (frame.cameraId !== 0 || frame.paused) return;
    if (this.lastAt !== undefined && now - this.lastAt > 2000) this.reset();
    this.lastAt = now;
    if (!(frame.flags & 2)) {
      this.reset();
      return;
    }
    const pressed = !!(frame.flags & 1);
    if (this.pressed === false && pressed) this.downAt = now;
    let event: "button_short" | "button_long" | undefined;
    if (this.pressed && !pressed && this.downAt !== undefined) {
      if (frame.flags & 4)
        event =
          frame.result === 1
            ? "button_short"
            : frame.result === 2
              ? "button_long"
              : undefined;
      else event = now - this.downAt >= 1000 ? "button_long" : "button_short";
    }
    if (!pressed) this.downAt = undefined;
    this.pressed = pressed;
    return event;
  }
}
// Same packed <IBBBBIIHHQ header as proxy/viewer.py; not a VDX2 envelope.
export class Cam2Parser {
  private buffer = new Uint8Array(1048576 + 28);
  private used = 0;
  private started?: number;
  get bufferedBytes() {
    return this.used;
  }
  reset() {
    this.used = 0;
    this.started = undefined;
  }
  feed(data: Uint8Array, now: number, emit: (frame: Cam2Frame) => void) {
    let offset = 0;
    do {
      const count = Math.min(
        data.length - offset,
        this.buffer.length - this.used,
      );
      this.buffer.set(data.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      this.parse(now, emit);
    } while (offset < data.length);
  }
  private discard(count: number) {
    this.buffer.copyWithin(0, count, this.used);
    this.used -= count;
    this.started = undefined;
  }
  private parse(now: number, emit: (frame: Cam2Frame) => void) {
    const a = this.buffer,
      d = new DataView(a.buffer);
    while (this.used >= 4) {
      let offset = 0;
      while (
        offset <= this.used - 4 &&
        !(
          a[offset] === 67 &&
          a[offset + 1] === 65 &&
          a[offset + 2] === 77 &&
          a[offset + 3] === 50
        )
      )
        offset++;
      if (offset) {
        this.discard(offset);
        continue;
      }
      this.started ??= now;
      if (now - this.started >= 6000) {
        this.discard(1);
        continue;
      }
      if (this.used < 28) return;
      const cameraId = a[4],
        flags = a[5],
        result = a[6],
        frameId = d.getUint32(8, true),
        size = d.getUint32(12, true),
        width = d.getUint16(16, true),
        height = d.getUint16(18, true);
      const paused =
        cameraId === 1 &&
        flags === 8 &&
        result === 0 &&
        size === 0 &&
        width === 0 &&
        height === 0;
      const validFlags =
        (flags === 0 && result === 0) ||
        (cameraId === 0 &&
          (((flags === 2 || flags === 3 || flags === 4) && result === 0) ||
            ((flags === 6 || flags === 7) && result <= 2)));
      if (
        a[7] !== 0 ||
        !(
          paused ||
          (cameraId <= 1 &&
            validFlags &&
            size >= 4 &&
            size <= 1048576 &&
            width > 0 &&
            width <= 4096 &&
            height > 0 &&
            height <= 4096)
        )
      ) {
        this.discard(1);
        continue;
      }
      const end = 28 + size;
      if (this.used < end) return;
      if (
        !paused &&
        !(
          a[28] === 255 &&
          a[29] === 216 &&
          a[end - 2] === 255 &&
          a[end - 1] === 217
        )
      ) {
        this.discard(1);
        continue;
      }
      const frame = {
        cameraId,
        flags,
        result,
        paused,
        frameId,
        width,
        height,
        cameraUs: d.getBigUint64(20, true),
        jpeg: a.slice(28, end),
      };
      this.discard(end);
      emit(frame);
    }
  }
}
