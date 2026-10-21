import type { Frame } from "./wire";

import {
  Cam2Parser,
  Cam2Buttons,
  encodeCommand,
  type UsbControlRecord,
  type Cam2Frame,
  type ButtonDecision,
} from "./usb-wire";
import { UsbCdc, browserUsb, type UsbApi, type UsbDevice } from "./usb-cdc";
export type Control = { type: "button_short" | "button_long" };
export interface ButtonDiagnostics {
  availability: "no-frame" | "live" | "stale" | "disconnected";
  frameId: number | null;
  receivedAt: number | null;
  rawFlags: number | null;
  valid: boolean;
  classified: boolean;
  pressed: "pressed" | "released" | "unknown";
  result: number | null;
  decision: ButtonDecision;
  shortCount: number;
  longCount: number;
  lastEvent: { type: Control["type"]; at: number } | null;
}
function emptyDiagnostics(): ButtonDiagnostics {
  return {
    availability: "no-frame", frameId: null, receivedAt: null,
    rawFlags: null, valid: false, classified: false, pressed: "unknown", result: null,
    decision: "baseline", shortCount: 0, longCount: 0, lastEvent: null,
  };
}
let nextEpoch = 0;
export class UsbFrameSource {
  private diagnostics = emptyDiagnostics();
  private mode: "hello" | "legacy" | "cdc2" = "hello";
  private session = 0;
  private eventId = 0;
  private requestId = 0;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAt = 0;
  private pingTimer?: ReturnType<typeof setInterval>;
  private port?: UsbCdc;
  private running = false;
  private generation = 0;
  private epoch = 0;
  private sequence = 0;
  private lastId?: number;
  private lastFrame = 0;
  private stale = false;
  private parser = new Cam2Parser();
  private buttons = new Cam2Buttons();
  private watch?: ReturnType<typeof setInterval>;
  private pending?: {
    width: number;
    height: number;
    sent: boolean;
    observed: boolean;
    ack: boolean;
    mode: 0 | 1 | 2;
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private onFrame: (frame: Frame) => void,
    private onControl: (event: Control) => void,
    private onState: (state: string) => void,
    private usb: UsbApi | undefined = browserUsb(),
    private protocol: "legacy" | "cdc2" = "legacy",
    private onDiagnostics: (value: ButtonDiagnostics) => void = () => {},
  ) {}
  private unplug = (event: { device: UsbDevice }) => {
    if (event.device === this.port?.device)
      this.fail("USB 장치 분리 · USB 연결을 다시 누르세요");
  };
  async start() {
    if (this.running) return;
    this.diagnostics = emptyDiagnostics();
    this.publishDiagnostics();
    if (!this.usb) {
      this.onState(
        "UNKNOWN · WebUSB 미지원 · Android Chrome의 HTTPS 페이지와 USB OTG가 필요합니다",
      );
      return;
    }
    this.running = true;
    this.mode = "hello";
    const generation = ++this.generation;
    this.onState("CONNECTING · USB 장치 선택");
    try {
      // No await before requestDevice: must retain the UI's user activation.
      const device = await this.usb.requestDevice({
        filters: [{ vendorId: 0x303a, productId: 0x1001 }],
      });
      if (generation !== this.generation) return;
      const port = (this.port = new UsbCdc(device));
      await port.open();
      if (generation !== this.generation) {
        await port.close();
        return;
      }
      this.epoch = ++nextEpoch;
      this.sequence = 0;
      this.lastId = undefined;
      this.parser.reset();
      this.buttons.reset();
      this.stale = false;
      this.lastFrame = performance.now();
      this.usb.addEventListener("disconnect", this.unplug);
      this.mode = this.protocol === "cdc2" ? "hello" : "legacy";
      this.session = 0;
      this.eventId = 0;
      // Old receivers interpret every byte as a mode. Never probe by default.
      if (this.protocol === "cdc2") {
        this.helloTimer = setTimeout(() => {
          if (generation !== this.generation || this.mode !== "hello") return;
          this.mode = "legacy";
          this.onState("CONNECTED");
          this.sendPending();
        }, 1500);
        void this.send(encodeCommand({ type: "hello" }, 0));
      } else {
        this.onState("CONNECTED");
        this.sendPending();
      }
      this.watch = setInterval(() => {
        const now = performance.now();
        try {
          this.parser.feed(
            new Uint8Array(),
            now,
            () => {},
            () => {},
          );
        } catch {
          this.fail("USB2 partial timeout");
          return;
        }
        if (this.mode === "cdc2") {
          if (now - this.heartbeatAt > 3000) {
            this.fail("USB2 heartbeat timeout");
            return;
          }
        }
        if (!this.stale && now - this.lastFrame > 2000) {
          // Never reinterpret buffered, old bytes as a fresh frame on a timer.
          if (this.mode === "cdc2" && this.parser.bufferedBytes) {
            // Dropping part of a multiplexed record would lose record boundaries.
            this.fail(
              "USB2 incomplete stale record · USB 연결을 다시 누르세요",
            );
            return;
          }
          this.parser.reset();
          this.stale = true;
          this.buttons.reset();
          this.lastId = undefined;
          this.unavailableDiagnostics("stale");
          this.onState(
            "UNKNOWN · USB 영상 지연 · CAM 연결/전원 및 CDC 펌웨어 확인",
          );
        }
      }, 500);
      void this.read(generation, port);
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(
        error instanceof DOMException && error.name === "NotFoundError"
          ? "USB 선택 취소 · USB 연결을 다시 누르세요"
          : "USB 열기 실패 · 권한/케이블/OTG 또는 OS CDC 드라이버 점유 확인 (Android 기종별 제한)",
      );
    }
  }
  private async read(generation: number, port: UsbCdc) {
    try {
      while (generation === this.generation && this.running) {
        const bytes = await port.read();
        if (generation !== this.generation) return;
        const now = performance.now();
        // Process every control edge but deliver only the latest image per read.
        let latest: Frame | undefined;
        this.parser.feed(
          bytes,
          now,
          (frame) => {
            if (generation === this.generation)
              latest = this.receive(frame, now) ?? latest;
          },
          (record) => {
            if (generation === this.generation)
              this.receiveControl(record, now);
          },
        );
        if (
          latest &&
          latest.epoch === this.epoch &&
          generation === this.generation
        )
          this.onFrame(latest);
      }
    } catch {
      if (generation === this.generation)
        this.fail("USB 읽기 실패/연결 끊김 · USB 연결을 다시 누르세요");
    }
  }
  private receive(frame: Cam2Frame, now: number): Frame | undefined {
    if (frame.cameraId !== 0 || frame.paused) return;
    const ignored = frame.frameId === this.lastId || (
      this.lastId !== undefined &&
      (frame.frameId - this.lastId) >>> 0 >= 0x80000000
    );
    // Scalar metadata only; never retain a frame/JPEG in diagnostics.
    this.diagnostics = {
      ...this.diagnostics,
      frameId: frame.frameId, receivedAt: now, rawFlags: frame.flags,
      valid: !!(frame.flags & 2), classified: !!(frame.flags & 4),
      result: frame.result,
      pressed: !ignored && (frame.flags & 2)
        ? (frame.flags & 1 ? "pressed" : "released") : "unknown",
    };
    if (ignored) {
      this.diagnostics.decision = "frame-ignored";
      this.publishDiagnostics();
      return;
    }
    this.diagnostics.availability = "live";
    this.lastId = frame.frameId;
    this.lastFrame = now;
    if (this.stale) {
      this.stale = false;
      this.onState("CONNECTED");
    }
    const pending = this.pending;
    if (
      pending?.sent &&
      pending.width === frame.width &&
      pending.height === frame.height
    ) {
      pending.observed = true;
      this.completePending();
    }
    const type =
      this.mode === "legacy" ? this.buttons.observe(frame, now) : undefined;
    this.diagnostics.decision = this.mode === "legacy" ? this.buttons.decision : "inactive";
    if (type) this.acceptControl(type, now);
    else this.publishDiagnostics();
    return {
      epoch: this.epoch,
      sequence: ++this.sequence,
      frameId: frame.frameId,
      width: frame.width,
      height: frame.height,
      cameraUs: frame.cameraUs,
      s3Us: 0n,
      receivedAt: now,
      jpeg: frame.jpeg,
    };
  }
  resolution(mode: 0 | 1 | 2): Promise<void> {
    if (!this.port || !this.running)
      return Promise.reject(Error("USB 장치가 연결되지 않았습니다"));
    if (![0, 1, 2].includes(mode))
      return Promise.reject(Error("잘못된 해상도"));

    this.rejectPending("새 해상도 요청으로 취소");
    const [width, height] = [
      [320, 240],
      [640, 480],
      [1280, 1024],
    ][mode];
    return new Promise<void>((resolve, reject) => {
      const pending = {
        width,
        height,
        mode,
        id: `r${++this.requestId}`,
        sent: false,
        observed: false,
        ack: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pending === pending) {
            this.pending = undefined;
            reject(
              Error("USB 실제 해상도 확인 시간 초과 · 펌웨어/카메라 확인"),
            );
          }
        }, 6000),
      };
      this.pending = pending;
      this.sendPending();
    });
  }
  private async send(bytes: Uint8Array<ArrayBuffer>) {
    const generation = this.generation,
      port = this.port;
    if (!port || !this.running) return;
    try {
      await port.write(bytes);
    } catch {
      if (generation === this.generation) this.fail("USB 명령 전송 실패");
    }
  }
  private sendPending() {
    const pending = this.pending;
    if (!pending || pending.sent || this.mode === "hello") return;
    // Mark before dispatch: an input completion may race the write completion.
    pending.sent = true;
    void this.send(
      this.mode === "legacy"
        ? Uint8Array.of(pending.mode)
        : encodeCommand(
            { type: "resolution", request_id: pending.id, mode: pending.mode },
            this.session,
          ),
    );
  }
  private receiveControl({ epoch, value: v }: UsbControlRecord, now: number) {
    const fields: Record<string, string[]> = {
      connected: ["type", "epoch", "protocol"],
      heartbeat: ["type", "epoch", "camera_online", "button_online"],
      disconnected: ["type", "reason"],
      button_short: ["type", "epoch", "event_id"],
      button_long: ["type", "epoch", "event_id"],
      resolution_applied: [
        "type",
        "request_id",
        "mode",
        "width",
        "height",
        "reason",
      ],
      resolution_failed: [
        "type",
        "request_id",
        "mode",
        "width",
        "height",
        "reason",
      ],
    };
    const expected = typeof v.type === "string" ? fields[v.type] : undefined;
    if (
      !expected ||
      Object.keys(v).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(v, key))
    )
      throw Error("USB2 control fields");
    if (v.type === "connected") {
      if (this.mode !== "hello" || v.epoch !== epoch || v.protocol !== "cdc2")
        throw Error("USB2 unexpected connected");
      clearTimeout(this.helloTimer);
      this.mode = "cdc2";
      this.session = epoch;
      this.eventId = 0;
      this.epoch = ++nextEpoch;
      this.sequence = 0;
      this.lastId = undefined;
      this.buttons.reset();
      this.heartbeatAt = now;
      this.diagnostics = emptyDiagnostics();
      this.publishDiagnostics();
      const generation = this.generation;
      this.pingTimer = setInterval(() => {
        if (generation === this.generation && this.mode === "cdc2")
          void this.send(encodeCommand({ type: "ping" }, this.session));
      }, 1000);
      this.onState("CONNECTED");
      this.sendPending();
      return;
    }
    if (this.mode !== "cdc2" || epoch !== this.session)
      throw Error("USB2 stale session");
    if (v.type === "heartbeat") {
      if (
        v.epoch !== epoch ||
        typeof v.camera_online !== "boolean" ||
        typeof v.button_online !== "boolean"
      )
        throw Error("USB2 heartbeat");
      this.heartbeatAt = now;
      return;
    }
    if (v.type === "disconnected") throw Error("USB2 disconnected");
    if (v.type === "button_short" || v.type === "button_long") {
      if (
        v.epoch !== epoch ||
        !Number.isInteger(v.event_id) ||
        (v.event_id as number) < 1 ||
        (v.event_id as number) > 0xffffffff
      )
        throw Error("USB2 event");
      if ((v.event_id as number) <= this.eventId) return;
      this.eventId = v.event_id as number;
      this.acceptControl(v.type, now);
      return;
    }
    if (v.type === "resolution_applied" || v.type === "resolution_failed") {
      const dimensions = [
        [320, 240],
        [640, 480],
        [1280, 1024],
      ];
      if (
        typeof v.request_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(v.request_id) ||
        !Number.isInteger(v.mode) ||
        (v.mode as number) < 0 ||
        (v.mode as number) > 2 ||
        !Number.isInteger(v.width) ||
        !Number.isInteger(v.height) ||
        (v.width as number) < 0 ||
        (v.width as number) > 4096 ||
        (v.height as number) < 0 ||
        (v.height as number) > 4096
      )
        throw Error("USB2 resolution fields");
      if (
        v.type === "resolution_applied"
          ? v.reason !== "observed" ||
            v.width !== dimensions[v.mode as number][0] ||
            v.height !== dimensions[v.mode as number][1]
          : ![
              "timeout",
              "busy",
              "camera_unavailable",
              "camera_disconnected",
            ].includes(v.reason as string)
      )
        throw Error("USB2 resolution result");
      const pending = this.pending;
      if (
        !pending ||
        !pending.sent ||
        v.request_id !== pending.id ||
        v.mode !== pending.mode
      )
        return;
      if (
        v.type === "resolution_applied" &&
        (v.width !== pending.width ||
          v.height !== pending.height ||
          v.reason !== "observed")
      )
        throw Error("USB2 invalid resolution ACK");
      if (v.type === "resolution_applied") {
        pending.ack = true;
        this.completePending();
      } else this.rejectPending(`USB 해상도 실패: ${v.reason}`);
      return;
    }
    throw Error("USB2 unknown control");
  }
  private publishDiagnostics() {
    this.onDiagnostics({ ...this.diagnostics,
      lastEvent: this.diagnostics.lastEvent ? { ...this.diagnostics.lastEvent } : null,
    });
  }
  private unavailableDiagnostics(availability: "stale" | "disconnected") {
    this.diagnostics = { ...this.diagnostics, availability, pressed: "unknown" };
    this.publishDiagnostics();
  }
  private acceptControl(type: Control["type"], now: number) {
    const key = type === "button_short" ? "shortCount" : "longCount";
    this.diagnostics[key] = Math.min(Number.MAX_SAFE_INTEGER, this.diagnostics[key] + 1);
    this.diagnostics.lastEvent = { type, at: now };
    this.diagnostics.decision = "accepted";
    this.publishDiagnostics();
    this.onControl({ type });
  }
  private completePending() {
    const pending = this.pending;
    if (!pending?.observed || (this.mode === "cdc2" && !pending.ack)) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve();
  }
  private rejectPending(reason: string) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(Error(reason));
      this.pending = undefined;
    }
  }
  private fail(reason: string) {
    this.running = false;
    ++this.generation;
    clearInterval(this.watch);
    clearTimeout(this.helloTimer);
    clearInterval(this.pingTimer);
    this.session = 0;
    this.eventId = 0;
    this.watch = undefined;
    this.usb?.removeEventListener("disconnect", this.unplug);
    const port = this.port;
    this.port = undefined;
    if (port) void port.close();
    this.parser.reset();
    this.buttons.reset();
    this.rejectPending(reason);
    this.unavailableDiagnostics("disconnected");
    this.onState(`UNKNOWN · ${reason}`);
  }
  stop() {
    this.fail("USB 연결 종료");
  }
}
