import type { Frame } from "./wire";
import { LatestQueue } from "./wire";
import type { DetectionResult } from "../vision/detector";
import type { Rotation } from "./orientation";
export class WalkingScheduler {
  private rotation: Rotation = "cw90";
  runtime = "initializing";
  setRotation(rotation: Rotation) {
    this.rotation = rotation;
    this.reset();
  }
  private worker: Worker;
  private pending = new LatestQueue<Frame>();
  private busy = false;
  private generation = 0;
  private lastSubmitted = 0;
  private lastResult = 0;
  private timer: ReturnType<typeof setInterval>;
  processed = 0;
  dropped = 0;
  state = "UNKNOWN";
  constructor(private result: (r: DetectionResult) => void) {
    this.worker = new Worker(new URL("./walking.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }) => {
      if (data.generation !== this.generation) return;
      if (data.type === "ready") {
        this.busy = false;
        this.pump();
      } else if (data.type === "result") {
        this.runtime = data.runtime ?? "javascript";
        this.lastResult = performance.now();
        this.processed++;
        if (performance.now() - data.receivedAt > 1500)
          this.unknown("처리 지연 · 보행 감지 저하");
        else {
          this.state = data.result.state;
          this.result(data.result);
        }
      } else if (data.type === "stale" && data.result.state === "UNKNOWN") {
        this.state = "UNKNOWN";
        this.result(data.result);
      }
    };
    this.worker.onerror = () => {
      this.busy = false;
      this.unknown("영상 Worker 오류 · 앱을 다시 여세요");
    };
    this.timer = setInterval(() => {
      if (this.lastResult && performance.now() - this.lastResult > 2000)
        this.unknown("보행 처리 지연");
      if (this.busy && performance.now() - this.lastSubmitted > 5000) {
        this.worker.terminate();
        this.unknown("Worker 응답 없음 · 앱을 다시 여세요");
      }
    }, 500);
  }
  submit(frame: Frame) {
    if (this.busy) this.dropped++;
    this.pending.push(frame);
    this.pump();
  }
  private pump() {
    if (this.busy) return;
    const frame = this.pending.take();
    if (!frame) return;
    this.busy = true;
    this.lastSubmitted = performance.now();
    const jpeg = frame.jpeg.slice();
    this.worker.postMessage(
      {
        type: "frame",
        generation: this.generation,
        jpeg,
        width: frame.width,
        height: frame.height,
        rotation: this.rotation,
        receivedAt: frame.receivedAt,
      },
      [jpeg.buffer],
    );
  }
  private unknown(reason: string) {
    this.state = "UNKNOWN";
    this.result({ state: "UNKNOWN", reason, total: 0, central: 0 });
  }
  reset() {
    this.generation++;
    this.pending.clear();
    this.busy = false;
    this.lastResult = 0;
    this.worker.postMessage({ type: "reset", generation: this.generation });
    this.unknown("새 영상 대기");
  }
  dispose() {
    clearInterval(this.timer);
    this.pending.clear();
    this.worker.terminate();
  }
}
