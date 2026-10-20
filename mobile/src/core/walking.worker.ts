/// <reference lib="webworker" />
import {
  ObstacleDetector,
  initializeVision,
  visionRuntimeStatus,
} from "../vision/detector";
import { drawOriented, orientedSize } from "./orientation";
const initialized = initializeVision();
const detector = new ObstacleDetector();
let generation = 0;
self.onmessage = async ({ data }) => {
  if (data.type === "reset") {
    generation = data.generation;
    detector.reset();
    return;
  }
  if (data.type !== "frame") return;
  const current = data.generation;
  let bitmap: ImageBitmap | undefined;
  try {
    await initialized;
    if (current !== generation) return;
    bitmap = await createImageBitmap(
      new Blob([data.jpeg], { type: "image/jpeg" }),
    );
    if (current !== generation) return;
    if (bitmap.width !== data.width || bitmap.height !== data.height)
      throw Error("JPEG dimensions mismatch");
    const inputWidth = 320,
      inputHeight = Math.round((bitmap.height * 320) / bitmap.width);
    const [width, height] = orientedSize(
      inputWidth,
      inputHeight,
      data.rotation,
    );
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw Error("OffscreenCanvas unavailable");
    drawOriented(ctx, bitmap, inputWidth, inputHeight, data.rotation);
    const result = detector.analyze(
      ctx.getImageData(0, 0, width, height).data,
      width,
      height,
      performance.now(),
    );
    self.postMessage({
      type: "result",
      generation: current,
      runtime: visionRuntimeStatus(),
      result,
      receivedAt: data.receivedAt,
    });
  } catch {
    self.postMessage({
      type: "result",
      generation: current,
      result: {
        state: "UNKNOWN",
        reason: "영상 해석 실패",
        total: 0,
        central: 0,
      },
      receivedAt: data.receivedAt,
    });
  } finally {
    bitmap?.close();
    self.postMessage({ type: "ready", generation: current });
  }
};
setInterval(
  () =>
    self.postMessage({
      type: "stale",
      generation,
      result: detector.markStale(performance.now()),
    }),
  500,
);
