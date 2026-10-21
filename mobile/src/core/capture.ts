import type { Frame } from "./wire";
import { drawOriented, orientedSize, type Rotation } from "./orientation";
export interface Quality {
  ok: boolean;
  reason: string;
}
export function assessQuality(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Quality {
  if (w < 32 || h < 32 || rgba.length !== w * h * 4)
    return { ok: false, reason: "잘못된 이미지" };
  let sum = 0,
    square = 0,
    edge = 0,
    n = 0;
  const gray = (i: number) =>
    rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  for (let y = 1; y < h; y++)
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4,
        v = gray(i);
      sum += v;
      square += v * v;
      edge += Math.abs(v - gray(i - 4)) + Math.abs(v - gray(i - w * 4));
      n++;
    }
  const mean = sum / n,
    variance = square / n - mean * mean;
  if (mean < 25 || mean > 235)
    return {
      ok: false,
      reason: "너무 어둡거나 밝습니다. 조명을 바꿔 다시 촬영하세요",
    };
  if (variance < 100 || edge / n < 4)
    return {
      ok: false,
      reason: "흐리거나 정보가 부족합니다. 흔들림 없이 다시 촬영하세요",
    };
  return { ok: true, reason: "품질 확인" };
}
export class CaptureSession {
  private frontAnalysis?: Uint8Array;
  kind: "ocr" | "object" = "ocr";
  stage: "idle" | "front" | "back" | "ready" = "idle";
  images: string[] = [];
  begin(kind: "ocr" | "object") {
    this.reset();
    this.kind = kind;
    this.stage = "front";
  }
  accept(image: string, quality: Quality, analysis?: Uint8Array) {
    if (!quality.ok) throw Error(quality.reason);
    if (!["front", "back"].includes(this.stage))
      throw Error("촬영 세션이 준비되지 않았습니다");
    if (this.images.includes(image))
      throw Error("앞면과 뒷면을 별도로 촬영하세요");
    if (this.kind === "object" && this.frontAnalysis && analysis) {
      if (analysis.length !== this.frontAnalysis.length)
        throw Error("앞뒷면 이미지 크기가 다릅니다");
      let difference = 0;
      for (let i = 0; i < analysis.length; i++)
        difference += Math.abs(analysis[i] - this.frontAnalysis[i]);
      if (difference / analysis.length / 255 < 0.055)
        throw Error("앞면과 같습니다. 물체를 뒤집어서 뒷면을 보여주세요");
    }
    if (this.kind === "object" && !this.images.length)
      this.frontAnalysis = analysis;
    this.images.push(image);
    this.stage =
      this.kind === "object" && this.images.length === 1 ? "back" : "ready";
  }
  reset() {
    this.frontAnalysis = undefined;
    this.images = [];
    this.stage = "idle";
  }
}
export async function selectFrame(
  frame: Frame,
  rotation: Rotation = "cw90",
  jpegQuality = 0.95,
) {
  const bitmap = await createImageBitmap(
    new Blob([frame.jpeg], { type: "image/jpeg" }),
  );
  try {
    if (bitmap.width !== frame.width || bitmap.height !== frame.height)
      throw Error("JPEG 실제 크기가 헤더와 다릅니다");
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = orientedSize(
      bitmap.width,
      bitmap.height,
      rotation,
    );
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw Error("Canvas 사용 불가");
    drawOriented(ctx, bitmap, bitmap.width, bitmap.height, rotation);
    const sample = document.createElement("canvas");
    sample.width = Math.min(160, canvas.width);
    sample.height = Math.round((canvas.height * sample.width) / canvas.width);
    const sc = sample.getContext("2d", { willReadFrequently: true })!;
    sc.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = sc.getImageData(0, 0, sample.width, sample.height).data;
    const analysis = new Uint8Array(sample.width * sample.height);
    for (let i = 0; i < analysis.length; i++)
      analysis[i] = Math.round(
        pixels[i * 4] * 0.299 +
          pixels[i * 4 + 1] * 0.587 +
          pixels[i * 4 + 2] * 0.114,
      );
    // Main OCR and object manual confirmation do not enforce auto-quality scores.
    return {
      image: canvas.toDataURL("image/jpeg", jpegQuality),
      quality: { ok: true, reason: "수동 촬영" },
      analysis,
    };
  } finally {
    bitmap.close();
  }
}
export async function mergeSides(images: string[]) {
  if (images.length !== 2) throw Error("앞면과 뒷면이 필요합니다");
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const image of images) {
      const bytes = Uint8Array.from(atob(image.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      bitmaps.push(
        await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })),
      );
    }
    const h = Math.min(1200, Math.max(...bitmaps.map((b) => b.height)));
    const widths = bitmaps.map((b) => Math.round((b.width * h) / b.height));
    const scale = Math.min(1, 1800 / (widths[0] + widths[1]));
    const c = document.createElement("canvas");
    c.width = Math.min(1800, widths[0] + widths[1]);
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    const leftWidth = Math.round(widths[0] * scale);
    ctx.drawImage(bitmaps[0], 0, 0, leftWidth, c.height);
    ctx.drawImage(bitmaps[1], leftWidth, 0, c.width - leftWidth, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } finally {
    bitmaps.forEach((b) => b.close());
  }
}
