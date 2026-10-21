import { drawOriented, orientedSize, type Rotation } from "./orientation";
import type { Frame } from "./wire";
export interface PreviewInput {
  frame?: Frame;
  rotation: Rotation;
  version: number;
  connection: string;
}
export interface PreviewStatus {
  kind: "no-frame" | "loading" | "live" | "stale" | "disconnected" | "error";
  frameId?: number;
  width?: number;
  height?: number;
}
export class PreviewRenderer {
  private canvas?: HTMLCanvasElement;
  private changed?: (status: PreviewStatus) => void;
  private generation = 0;
  private context?: string;
  private busy = false;
  private pending?: { frame: Frame; rotation: Rotation };
  private last?: Frame;
  attach(canvas: HTMLCanvasElement, changed: (status: PreviewStatus) => void) {
    this.detach();
    this.canvas = canvas;
    this.changed = changed;
  }
  update(input: PreviewInput) {
    if (!this.canvas) return;
    const context = `${input.version}/${input.rotation}/${input.frame?.epoch}/${input.connection}`;
    if (context !== this.context) {
      ++this.generation;
      this.context = context;
      this.pending = undefined;
      this.last = undefined;
      this.clear();
    }
    const kind =
      input.connection !== "CONNECTED"
        ? input.connection.includes("영상 지연")
          ? "stale"
          : input.connection.startsWith("CONNECTING")
            ? "no-frame"
            : "disconnected"
        : !input.frame
          ? "no-frame"
          : performance.now() - input.frame.receivedAt > 2000
            ? "stale"
            : undefined;
    if (kind || !input.frame) {
      ++this.generation;
      this.pending = undefined;
      this.last = undefined;
      this.clear();
      this.changed?.({ kind: kind ?? "no-frame" });
      return;
    }
    if (input.frame !== this.last)
      this.pending = { frame: input.frame, rotation: input.rotation };
    if (!this.canvas.width && this.pending) this.changed?.({ kind: "loading" });
    this.pump();
  }
  private pump() {
    if (this.busy || !this.pending || !this.canvas) return;
    const { frame, rotation } = this.pending;
    this.pending = undefined;
    this.last = frame;
    if (performance.now() - frame.receivedAt > 2000) {
      this.clear();
      this.changed?.({ kind: "stale" });
      return;
    }
    this.busy = true;
    void this.draw(frame, rotation);
  }
  private async draw(frame: Frame, rotation: Rotation) {
    const generation = this.generation;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(
        new Blob([frame.jpeg], { type: "image/jpeg" }),
      );
      if (!this.canvas || generation !== this.generation) return;
      if (performance.now() - frame.receivedAt > 2000) {
        this.clear();
        this.changed?.({ kind: "stale" });
        return;
      }
      if (bitmap.width !== frame.width || bitmap.height !== frame.height)
        throw Error("JPEG dimensions");
      [this.canvas.width, this.canvas.height] = orientedSize(
        frame.width,
        frame.height,
        rotation,
      );
      const ctx = this.canvas.getContext("2d");
      if (!ctx) throw Error("Canvas unavailable");
      drawOriented(ctx, bitmap, frame.width, frame.height, rotation);
      this.changed?.({
        kind: "live",
        frameId: frame.frameId,
        width: frame.width,
        height: frame.height,
      });
    } catch {
      if (generation === this.generation) {
        this.clear();
        this.changed?.({ kind: "error" });
      }
    } finally {
      bitmap?.close();
      this.busy = false;
      this.pump();
    }
  }
  private clear() {
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
  }
  detach() {
    ++this.generation;
    this.context = undefined;
    this.pending = undefined;
    this.last = undefined;
    // Do not reset busy: a hidden/reopened panel shares the in-flight decode.
    this.clear();
    this.canvas = undefined;
    this.changed = undefined;
  }
}
