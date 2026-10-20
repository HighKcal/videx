import type { Frame } from "./wire";
import type { Control } from "./source";
import { Cam2Parser, Cam2Buttons, type Cam2Frame } from "./usb-wire";
import { UsbCdc, browserUsb, type UsbApi, type UsbDevice } from "./usb-cdc";
export type UsbProfile = "legacy" | "v2-mirror";
let nextEpoch = 0;
export class UsbFrameSource {
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
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private profile: UsbProfile,
    private onFrame: (frame: Frame) => void,
    private onControl: (event: Control) => void,
    private onState: (state: string) => void,
    private usb: UsbApi | undefined = browserUsb(),
  ) {}
  private unplug = (event: { device: UsbDevice }) => {
    if (event.device === this.port?.device)
      this.fail("USB 장치 분리 · USB 연결을 다시 누르세요");
  };
  async start() {
    if (this.running) return;
    if (!this.usb) {
      this.onState(
        "UNKNOWN · WebUSB 미지원 · Android Chrome의 HTTPS 페이지와 USB OTG가 필요합니다",
      );
      return;
    }
    this.running = true;
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
      this.onState("CONNECTED");
      this.watch = setInterval(() => {
        const now = performance.now();
        if (!this.stale && now - this.lastFrame > 2000) {
          // Never reinterpret buffered, old bytes as a fresh frame on a timer.
          this.parser.reset();
          this.stale = true;
          this.buttons.reset();
          this.lastId = undefined;
          this.onState(
            "UNKNOWN · USB 영상 지연 · CAM 연결/전원 및 v2 usb_diag 설정 확인",
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
        this.parser.feed(bytes, now, (frame) => {
          latest = this.receive(frame, now) ?? latest;
        });
        if (latest && generation === this.generation) this.onFrame(latest);
      }
    } catch {
      if (generation === this.generation)
        this.fail("USB 읽기 실패/연결 끊김 · USB 연결을 다시 누르세요");
    }
  }
  private receive(frame: Cam2Frame, now: number): Frame | undefined {
    if (frame.cameraId !== 0 || frame.paused) return;
    if (
      this.lastId !== undefined &&
      (frame.frameId - this.lastId) >>> 0 >= 0x80000000
    )
      return;
    if (frame.frameId === this.lastId) return;
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
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve();
    }
    if (this.profile === "legacy") {
      const type = this.buttons.observe(frame, now);
      if (type) this.onControl({ type });
    }
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
    if (this.profile === "v2-mirror" && mode !== 0)
      return Promise.reject(
        Error(
          "v2 USB 미러는 읽기 전용입니다. 고해상도 변경/물리 버튼은 WSS에서만 지원됩니다",
        ),
      );
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
        sent: this.profile === "v2-mirror",
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
      if (this.profile === "legacy")
        void this.port!.write(Uint8Array.of(mode))
          .then(() => {
            if (this.pending === pending) pending.sent = true;
          })
          .catch(() => {
            if (this.pending === pending) this.fail("USB 명령 전송 실패");
          });
    });
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
    this.watch = undefined;
    this.usb?.removeEventListener("disconnect", this.unplug);
    const port = this.port;
    this.port = undefined;
    if (port) void port.close();
    this.parser.reset();
    this.buttons.reset();
    this.rejectPending(reason);
    this.onState(`UNKNOWN · ${reason}`);
  }
  stop() {
    this.fail("USB 연결 종료");
  }
}
