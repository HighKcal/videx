import { LatestQueue, parseFrame, type Frame } from "./wire";
export type Control = { type: string; [key: string]: unknown };
export interface Pairing {
  url: string;
  host: string;
  token: string;
}
export function validateEndpoint(value: string, host: string) {
  const u = new URL(value);
  if (
    u.protocol !== "wss:" ||
    u.host !== host ||
    u.pathname !== "/ws" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    !host
  )
    throw Error("페어링된 정확한 WSS 장치 /ws 주소가 필요합니다");
  return u.href;
}
export class S3FrameSource {
  private stale = false;
  private socket?: WebSocket;
  private running = false;
  private generation = 0;
  private epoch?: number;
  private sequence?: number;
  private lastEvent = -1;
  private frames = new LatestQueue<Frame>();
  private controls: Control[] = [];
  private draining = false;
  private retry?: ReturnType<typeof setTimeout>;
  private watch?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastFrame = 0;
  private lastMessage = 0;
  private pending = new Map<
    string,
    {
      mode: number;
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private config: Pairing,
    private onFrame: (f: Frame) => void,
    private onControl: (e: Control) => void,
    private onState: (state: string) => void,
    private factory: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {
    validateEndpoint(config.url, config.host);
    if (!config.token) throw Error("페어링 토큰 필요");
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.watch = setInterval(() => {
      const now = performance.now();
      if (
        this.epoch !== undefined &&
        now - this.lastFrame > 2000 &&
        !this.stale
      ) {
        this.stale = true;
        this.onState("UNKNOWN · 영상 지연");
      }
      if (this.epoch !== undefined && now - this.lastMessage > 10000)
        this.fail("장치 응답 시간 초과");
    }, 500);
  }
  private connect() {
    if (!this.running) return;
    const generation = ++this.generation;
    this.stale = false;
    this.epoch = undefined;
    this.sequence = undefined;
    this.lastEvent = -1;
    this.frames.clear();
    this.controls = [];
    this.onState("CONNECTING");
    const socket = (this.socket = this.factory(
      validateEndpoint(this.config.url, this.config.host),
    ));
    socket.binaryType = "arraybuffer";
    this.deadline = setTimeout(() => this.fail("인증 시간 초과"), 5000);
    socket.onopen = () => {
      if (generation !== this.generation) return;
      socket.send(
        JSON.stringify({ type: "authenticate", token: this.config.token }),
      );
    };
    socket.onmessage = ({ data }) => {
      if (generation !== this.generation || !this.running) return;
      this.lastMessage = performance.now();
      try {
        if (typeof data === "string") {
          if (data.length > 8192) throw Error("Control too large");
          const event = JSON.parse(data) as Control;
          if (!event || typeof event.type !== "string")
            throw Error("Invalid control");
          if (event.type === "connected") {
            if (
              this.epoch !== undefined ||
              !Number.isInteger(event.epoch) ||
              Number(event.epoch) < 0
            )
              throw Error("Invalid session");
            clearTimeout(this.deadline);
            this.epoch = Number(event.epoch);
            this.attempts = 0;
            this.lastFrame = performance.now();
            this.onState("CONNECTED");
          } else if (this.epoch === undefined) return;
          if (event.type === "button_short" || event.type === "button_long") {
            if (
              event.epoch !== this.epoch ||
              !Number.isInteger(event.event_id) ||
              Number(event.event_id) <= this.lastEvent
            )
              return;
            this.lastEvent = Number(event.event_id);
          }
          if (
            event.type === "resolution_applied" ||
            event.type === "resolution_failed"
          ) {
            const id = String(event.request_id),
              p = this.pending.get(id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(id);
              const [w, h] = [
                [320, 240],
                [640, 480],
                [1280, 1024],
              ][p.mode];
              if (
                event.type === "resolution_applied" &&
                event.mode === p.mode &&
                event.width === w &&
                event.height === h
              )
                p.resolve();
              else p.reject(Error("해상도 변경 실패 / 실제 크기 불일치"));
            }
          }
          if (event.type === "disconnected") {
            this.fail("장치 연결 끊김");
            return;
          }
          if (this.controls.length >= 32) throw Error("Control overflow");
          this.controls.push(event);
        } else if (data instanceof ArrayBuffer && this.epoch !== undefined) {
          const f = parseFrame(data, performance.now());
          if (
            f.epoch !== this.epoch ||
            (this.sequence !== undefined &&
              (f.sequence - this.sequence) >>> 0 >= 0x80000000) ||
            f.sequence === this.sequence
          )
            return;
          this.sequence = f.sequence;
          this.lastFrame = f.receivedAt;
          if (this.stale) {
            this.stale = false;
            this.onState("CONNECTED");
          }
          this.frames.push(f);
        }
        this.drain();
      } catch {
        this.fail("잘못된 장치 데이터 · 연결 중단");
      }
    };
    socket.onerror = () => {
      if (generation === this.generation) this.fail("TLS/네트워크 오류");
    };
    socket.onclose = () => {
      if (generation === this.generation) this.fail("연결 끊김");
    };
  }
  private drain() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      for (const event of this.controls.splice(0)) this.onControl(event);
      const f = this.frames.take();
      if (f) this.onFrame(f);
    });
  }
  private fail(reason: string) {
    ++this.generation;
    clearTimeout(this.deadline);
    this.socket?.close();
    this.socket = undefined;
    this.epoch = undefined;
    this.frames.clear();
    this.controls = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(reason));
    }
    this.pending.clear();
    this.onState(`UNKNOWN · ${reason}`);
    if (this.running && !this.retry)
      this.retry = setTimeout(
        () => {
          this.retry = undefined;
          this.connect();
        },
        Math.min(15000, 500 * 2 ** Math.min(this.attempts++, 5)),
      );
  }
  resolution(mode: 0 | 1 | 2): Promise<void> {
    if (this.epoch === undefined || this.socket?.readyState !== 1)
      return Promise.reject(Error("장치가 연결되지 않았습니다"));
    if (this.pending.size >= 4)
      return Promise.reject(Error("해상도 요청 큐 가득 참"));
    const request_id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(Error("해상도 ACK 시간 초과"));
      }, 6000);
      this.pending.set(request_id, { mode, resolve, reject, timer });
      this.socket!.send(
        JSON.stringify({ type: "resolution", request_id, mode }),
      );
    });
  }
  stop() {
    this.running = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearInterval(this.watch);
    this.fail("연결 종료");
  }
}
