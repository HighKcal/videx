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
export type ButtonDecision =
  | "no-metadata" | "baseline" | "repeat" | "press"
  | "accepted" | "unclassified-release" | "inactive" | "frame-ignored";
export class Cam2Buttons {
  decision: ButtonDecision = "baseline";
  private pressed?: boolean;
  private downAt?: number;
  private lastAt?: number;
  reset() {
    this.decision = "baseline";
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
      this.decision = "no-metadata";
      return;
    }
    const pressed = !!(frame.flags & 1);
    this.decision = this.pressed === undefined ? "baseline" : "repeat";
    if (this.pressed === false && pressed) {
      this.downAt = now;
      this.decision = "press";
    }
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
      this.decision = event ? "accepted" : "unclassified-release";
    } else if (this.pressed && !pressed) {
      this.decision = "baseline";
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
  feed(
    data: Uint8Array,
    now: number,
    emit: (frame: Cam2Frame) => void,
    control: (record: UsbControlRecord) => void = () => {},
  ) {
    let offset = 0;
    do {
      const count = Math.min(
        data.length - offset,
        this.buffer.length - this.used,
      );
      this.buffer.set(data.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      this.parse(now, emit, control);
    } while (offset < data.length);
  }
  private discard(count: number) {
    this.buffer.copyWithin(0, count, this.used);
    this.used -= count;
    this.started = undefined;
  }
  private parse(
    now: number,
    emit: (frame: Cam2Frame) => void,
    control: (record: UsbControlRecord) => void,
  ) {
    const a = this.buffer,
      d = new DataView(a.buffer);
    while (this.used >= 4) {
      let offset = 0;
      while (
        offset <= this.used - 4 &&
        !(
          ((a[offset] === 67 && a[offset + 1] === 65 && a[offset + 2] === 77) ||
            (a[offset] === 85 &&
              a[offset + 1] === 83 &&
              a[offset + 2] === 66)) &&
          a[offset + 3] === 50
        )
      )
        offset++;
      if (offset) {
        this.discard(offset);
        continue;
      }
      this.started ??= now;
      if (a[0] === 85) {
        if (now - this.started >= 500) throw Error("USB2 partial timeout");
        if (this.used < 16) return;
        const size = d.getUint32(8, true),
          epoch = d.getUint32(12, true);
        if (
          a[4] !== 1 ||
          a[5] !== 2 ||
          d.getUint16(6, true) !== 0 ||
          size < 1 ||
          size > 255 ||
          epoch === 0
        )
          throw Error("USB2 header");
        if (this.used < 16 + size) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          a.subarray(16, 16 + size),
        );
        const value = JSON.parse(text);
        // Controls are flat objects. Tokenize whole strings (including escapes),
        // not substrings within a value, so duplicate keys cannot hide in JSON.
        const keys = new Set<string>();
        for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
          if (
            !text
              .slice(match.index! + match[0].length)
              .trimStart()
              .startsWith(":")
          )
            continue;
          const key = JSON.parse(match[0]) as string;
          if (keys.has(key)) throw Error("USB2 duplicate key");
          keys.add(key);
        }
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("USB2 JSON");
        this.discard(16 + size);
        control({ epoch, value });
        continue;
      }
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

export interface UsbControlRecord {
  epoch: number;
  value: Record<string, unknown>;
}
export function encodeCommand(
  value:
    | { type: "hello" }
    | { type: "ping" }
    | { type: "resolution"; request_id: string; mode: 0 | 1 | 2 },
  epoch: number,
): Uint8Array<ArrayBuffer> {
  const keys =
    value.type === "resolution" ? ["type", "request_id", "mode"] : ["type"];
  if (
    !["hello", "ping", "resolution"].includes(value.type) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("USB2 command fields");
  if (
    !Number.isInteger(epoch) ||
    epoch < 0 ||
    epoch > 0xffffffff ||
    (value.type === "hello" ? epoch !== 0 : epoch === 0)
  )
    throw Error("USB2 epoch");
  if (
    value.type === "resolution" &&
    (!/^[A-Za-z0-9_-]{1,64}$/.test(value.request_id) ||
      ![0, 1, 2].includes(value.mode))
  )
    throw Error("USB2 command");
  const payload = new TextEncoder().encode(JSON.stringify(value));
  if (payload.length < 1 || payload.length > 255) throw Error("USB2 length");
  const bytes = new Uint8Array(16 + payload.length),
    d = new DataView(bytes.buffer);
  bytes.set([85, 83, 66, 50, 1, 1, 0, 0]);
  d.setUint32(8, payload.length, true);
  d.setUint32(12, epoch, true);
  bytes.set(payload, 16);
  return bytes;
}
