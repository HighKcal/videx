import type { Frame } from "../src/core/wire";
export function frame(epoch = 7, sequence = 1, receivedAt = performance.now()): Frame {
  return { epoch, sequence, frameId: sequence, width: 320, height: 240, cameraUs: 0n, s3Us: 0n, receivedAt, jpeg: Uint8Array.of(255, 216, 255, 217) };
}
