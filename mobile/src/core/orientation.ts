export type Rotation = "none" | "cw90" | "ccw90" | "180";
export function orientedSize(
  width: number,
  height: number,
  rotation: Rotation,
): [number, number] {
  return rotation === "cw90" || rotation === "ccw90"
    ? [height, width]
    : [width, height];
}
export function drawOriented(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  rotation: Rotation,
) {
  ctx.save();
  if (rotation === "cw90") {
    ctx.translate(height, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === "ccw90") {
    ctx.translate(0, width);
    ctx.rotate(-Math.PI / 2);
  } else if (rotation === "180") {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(image, 0, 0, width, height);
  ctx.restore();
}
