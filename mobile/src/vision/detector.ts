/**
 * Dependency-free port of proxy/flood_fill.py's walking-obstacle analysis.
 * Input pixels are tightly packed upright RGBA. This reports image-space
 * obstacle candidates only; it does not estimate distance or guarantee safety.
 */
export type DetectionState = 'MONITORING' | 'WARNING' | 'UNKNOWN';

export interface DetectionResult {
  state: DetectionState;
  reason: string;
  total: number;
  central: number;
}

export interface DetectorOptions {
  staleAfterMs?: number;
  /** A frame-size change is not a consecutive observation of the same scene. */
}

const ROI_VERTICES: readonly [number, number][] = [
  [0.36, 0.42], [0.64, 0.42], [0.92, 0.97], [0.08, 0.97],
];
const TOTAL_THRESHOLD = 0.18;
const CENTER_THRESHOLD = 0.3;
const RELEASE_FACTOR = 0.7;
const CONFIRM_FRAMES = 3;
const MIN_IMAGE_SIZE = 32;
const STALE_AFTER_MS = 2000;
const DARK_LEVEL = 10;
const BRIGHT_LEVEL = 245;
const EXTREME_FRACTION = 0.98;
const MAX_BARRIER_DENSITY = 0.45;
const LOW = 50;
const HIGH = 150;

type FloodFillExports = {
  memory: WebAssembly.Memory;
  alloc_bytes(length: number): number;
  alloc_words(length: number): number;
  free_bytes(pointer: number, length: number): void;
  free_words(pointer: number, length: number): void;
  flood_fill(roi: number, barriers: number, output: number, queue: number,
    length: number, seed: number, width: number, height: number): number;
};

let wasmExports: FloodFillExports | null = null;
let initialization: Promise<'wasm' | 'javascript'> | null = null;

/** Load the bundled Rust flood-fill kernel once. On failure, keep using JS. */
export function initializeVision(source?: URL | ArrayBuffer):
Promise<'wasm' | 'javascript'> {
  if (initialization && source === undefined) return initialization;
  if (source !== undefined) initialization = null;
  const moduleSource = source ?? new URL('./flood_fill.wasm', import.meta.url);
  initialization = (async () => {
    try {
      let bytes: ArrayBuffer;
      if (moduleSource instanceof ArrayBuffer) bytes = moduleSource;
      else {
        const response = await fetch(moduleSource);
        if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
        bytes = await response.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes);
      wasmExports = instance.exports as unknown as FloodFillExports;
      if (!wasmExports.memory || !wasmExports.flood_fill || !wasmExports.alloc_bytes || !wasmExports.alloc_words) {
        throw new Error('WASM kernel exports missing');
      }
      return 'wasm';
    } catch {
      wasmExports = null;
      return 'javascript';
    }
  })();
  return initialization;
}

/** Runtime label for diagnostics; fallback is explicitly observable. */
export function visionRuntimeStatus(): 'wasm' | 'javascript' {
  return wasmExports ? 'wasm' : 'javascript';
}

/** Exposed for differential regression tests and worker diagnostics. */
export function floodFillMask(roi: Uint8Array, barriers: Uint8Array, width: number, height: number,
  seed: number): Uint8Array {
  return floodFill(roi, barriers, width, height, seed);
}

export function floodFillMaskWasm(roi: Uint8Array, barriers: Uint8Array, width: number, height: number,
  seed: number): Uint8Array {
  if (!wasmExports) return floodFill(roi, barriers, width, height, seed);
  try {
    return floodFillWasm(wasmExports, roi, barriers, width, height, seed);
  } catch {
    wasmExports = null;
    return floodFill(roi, barriers, width, height, seed);
  }
}

/**
 * Canny + 5x5 closing + 3x3 dilation + trapezoid ROI + 4-connected flood fill.
 * The edge detector uses Sobel gradients/non-maximum suppression and Canny
 * hysteresis, all implemented here without runtime or native dependencies.
 */
export class ObstacleDetector {
  private state: DetectionState = 'UNKNOWN';
  private reason = 'waiting for frames';
  private total = 0;
  private central = 0;
  private hits = 0;
  private clears = 0;
  private lastFrameAt: number | null = null;
  private lastNow = Number.NEGATIVE_INFINITY;
  private lastWidth: number | null = null;
  private lastHeight: number | null = null;
  private lastData: Uint8ClampedArray | null = null;
  private readonly staleAfterMs: number;

  constructor(options: DetectorOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new RangeError('staleAfterMs must be finite and positive');
    }
  }

  analyze(rgba: Uint8ClampedArray, width: number, height: number, nowMs: number): DetectionResult {
    if (!Number.isFinite(nowMs)) return this.invalidate('invalid frame timestamp');
    if (nowMs < this.lastNow) return this.invalidate('frame timestamp moved backwards');
    this.lastNow = nowMs;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
        width * height > 16_777_216 || !(rgba instanceof Uint8ClampedArray) ||
        rgba.length !== width * height * 4) {
      return this.invalidate('invalid frame dimensions or RGBA data');
    }
    // A duplicate buffer/time is not a new observation, so cannot confirm a warning.
    if (this.lastData === rgba && this.lastFrameAt === nowMs &&
        this.lastWidth === width && this.lastHeight === height) {
      return this.result();
    }

    const gap = this.lastFrameAt === null ? 0 : nowMs - this.lastFrameAt;
    if (gap > this.staleAfterMs) this.resetTemporalState();
    const sizeChanged = this.lastWidth !== null &&
      (this.lastWidth !== width || this.lastHeight !== height);
    if (sizeChanged) {
      this.resetTemporalState();
      this.total = 0;
      this.central = 0;
    }
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastData = rgba;
    this.lastFrameAt = nowMs;

    if (Math.min(width, height) < MIN_IMAGE_SIZE) return this.invalidate('image too small');

    const { roi, center, roiCount, centerCount } = makeRegions(width, height);
    if (roiCount === 0 || centerCount === 0) return this.invalidate('invalid analysis region');

    const gray = rgbaToGray(rgba, width, height);
    let dark = 0;
    let bright = 0;
    for (let i = 0; i < roi.length; i++) {
      if (roi[i] === 0) continue;
      if (gray[i] < DARK_LEVEL) dark++;
      if (gray[i] > BRIGHT_LEVEL) bright++;
    }
    if (dark / roiCount > EXTREME_FRACTION) return this.invalidate('ROI too dark / lens covered');
    if (bright / roiCount > EXTREME_FRACTION) return this.invalidate('ROI overexposed');

    const edges = canny(gray, width, height);
    const barriers = dilate3(close5(edges, width, height), width, height);
    let barrierCount = 0;
    for (let i = 0; i < barriers.length; i++) {
      if (roi[i] && barriers[i]) barrierCount++;
    }
    if (barrierCount / roiCount > MAX_BARRIER_DENSITY) {
      return this.invalidate('too many edge barriers / floor texture');
    }

    const seed = findSeed(roi, barriers, width, height);
    if (seed === -1) return this.invalidate('bottom-center seed blocked');
    const filled = floodFillMaskWasm(roi, barriers, width, height, seed);
    let unfilled = 0;
    let centralUnfilled = 0;
    for (let i = 0; i < roi.length; i++) {
      if (roi[i] && !filled[i]) {
        unfilled++;
        if (center[i]) centralUnfilled++;
      }
    }
    this.total = unfilled / roiCount;
    this.central = centralUnfilled / centerCount;

    const candidate = this.total >= TOTAL_THRESHOLD && this.central >= CENTER_THRESHOLD;
    const clear = this.total < TOTAL_THRESHOLD * RELEASE_FACTOR ||
      this.central < CENTER_THRESHOLD * RELEASE_FACTOR;
    this.hits = candidate ? this.hits + 1 : 0;
    this.clears = clear ? this.clears + 1 : 0;
    if (this.hits >= CONFIRM_FRAMES) {
      this.state = 'WARNING';
      this.reason = 'both thresholds exceeded on consecutive NEW frames';
    } else if (this.state === 'WARNING' && this.clears < CONFIRM_FRAMES) {
      this.reason = 'warning held; waiting for consecutive clear frames';
    } else {
      this.state = 'MONITORING';
      this.reason = candidate
        ? 'candidate; waiting for consecutive NEW frames'
        : 'below warning thresholds (not proof of a clear path)';
    }
    return this.result();
  }

  /** Explicitly invalidate a stalled stream; call from the worker timer. */
  markStale(nowMs: number): DetectionResult {
    if (!Number.isFinite(nowMs) || nowMs < this.lastNow) {
      return this.invalidate('invalid stale-check timestamp');
    }
    this.lastNow = nowMs;
    if (this.lastFrameAt === null || nowMs - this.lastFrameAt > this.staleAfterMs) {
      return this.invalidate(`no NEW frame for ${(this.staleAfterMs / 1000).toFixed(1)}s`);
    }
    return this.result();
  }

  reset(): void {
    this.state = 'UNKNOWN';
    this.reason = 'waiting for frames';
    this.total = 0;
    this.central = 0;
    this.hits = 0;
    this.clears = 0;
    this.lastFrameAt = null;
    this.lastNow = Number.NEGATIVE_INFINITY;
    this.lastWidth = null;
    this.lastHeight = null;
    this.lastData = null;
  }

  private resetTemporalState(): void {
    this.state = 'MONITORING';
    this.hits = 0;
    this.clears = 0;
  }

  private invalidate(reason: string): DetectionResult {
    this.state = 'UNKNOWN';
    this.reason = reason;
    this.hits = 0;
    this.clears = 0;
    this.lastData = null;
    this.lastFrameAt = null;
    return this.result();
  }

  private result(): DetectionResult {
    return { state: this.state, reason: this.reason, total: this.total, central: this.central };
  }
}

function makeRegions(width: number, height: number): {
  roi: Uint8Array; center: Uint8Array; roiCount: number; centerCount: number;
} {
  const roi = new Uint8Array(width * height);
  const center = new Uint8Array(width * height);
  const vertices = ROI_VERTICES.map(([x, y]) => [Math.round(x * (width - 1)), Math.round(y * (height - 1))] as const);
  const minY = Math.max(0, Math.min(...vertices.map((point) => point[1])));
  const maxY = Math.min(height - 1, Math.max(...vertices.map((point) => point[1])));
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const [x1, y1] = vertices[i];
      const [x2, y2] = vertices[(i + 1) % vertices.length];
      if (y1 === y2) {
        if (y === y1) intersections.push(x1, x2);
      } else if (y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) {
        intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    if (intersections.length < 2) continue;
    const left = Math.max(0, Math.ceil(Math.min(...intersections) - 1e-9));
    const right = Math.min(width - 1, Math.floor(Math.max(...intersections) + 1e-9));
    for (let x = left; x <= right; x++) roi[y * width + x] = 1;
  }
  const x0 = Math.round(width * 0.42);
  const x1 = Math.round(width * 0.58);
  const y0 = Math.round(height * 0.45);
  const y1 = Math.round(height * 0.85);
  let roiCount = 0;
  let centerCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (roi[i]) roiCount++;
      if (roi[i] && x >= x0 && x < x1 && y >= y0 && y < y1) {
        center[i] = 1;
        centerCount++;
      }
    }
  }
  return { roi, center, roiCount, centerCount };
}

function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
  }
  return gray;
}

function gaussian5(input: Uint8Array, width: number, height: number): Uint8Array {
  const kernel = [1, 4, 6, 4, 1];
  const temp = new Uint16Array(input.length);
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += input[y * width + clamp(x + k, 0, width - 1)] * kernel[k + 2];
    temp[y * width + x] = Math.floor((sum + 8) / 16);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += temp[clamp(y + k, 0, height - 1) * width + x] * kernel[k + 2];
    output[y * width + x] = Math.floor((sum + 8) / 16);
  }
  return output;
}

function canny(gray: Uint8Array, width: number, height: number): Uint8Array {
  const blurred = gaussian5(gray, width, height);
  const magnitude = new Uint32Array(gray.length);
  const angles = new Uint8Array(gray.length);
  const suppressed = new Uint32Array(gray.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = -blurred[i - width - 1] + blurred[i - width + 1] - 2 * blurred[i - 1] +
      2 * blurred[i + 1] - blurred[i + width - 1] + blurred[i + width + 1];
    const gy = -blurred[i - width - 1] - 2 * blurred[i - width] - blurred[i - width + 1] +
      blurred[i + width - 1] + 2 * blurred[i + width] + blurred[i + width + 1];
    magnitude[i] = Math.abs(gx) + Math.abs(gy);
    let angle = Math.atan2(gy, gx) * (180 / Math.PI);
    if (angle < 0) angle += 180;
    angles[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
  }
  const before = [-1, -width + 1, -width, -width - 1];
  const after = [1, width - 1, width, width + 1];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const a = magnitude[i + before[angles[i]]];
    const b = magnitude[i + after[angles[i]]];
    if (magnitude[i] >= a && magnitude[i] >= b) suppressed[i] = magnitude[i];
  }
  const edges = new Uint8Array(gray.length);
  const stack = new Int32Array(gray.length);
  let top = 0;
  for (let i = 0; i < suppressed.length; i++) if (suppressed[i] >= HIGH && edges[i] === 0) {
    edges[i] = 1;
    stack[top++] = i;
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const y = Math.floor(i / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx <= 0 || nx >= width - 1 || ny <= 0 || ny >= height - 1) continue;
      const next = ny * width + nx;
      if (!edges[next] && suppressed[next] >= LOW) {
        edges[next] = 1;
        stack[top++] = next;
      }
    }
  }
  return edges;
}

function close5(edges: Uint8Array, width: number, height: number): Uint8Array {
  const dilated = morphology(edges, width, height, 2, true);
  return morphology(dilated, width, height, 2, false);
}

function dilate3(input: Uint8Array, width: number, height: number): Uint8Array {
  return morphology(input, width, height, 1, true);
}

function morphology(input: Uint8Array, width: number, height: number, radius: number, dilate: boolean): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = dilate ? 0 : 1;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      const sample = nx < 0 || nx >= width || ny < 0 || ny >= height ? 0 : input[ny * width + nx];
      if (dilate) value = Math.max(value, sample);
      else value = Math.min(value, sample);
    }
    output[y * width + x] = value;
  }
  return output;
}

function findSeed(roi: Uint8Array, barriers: Uint8Array, width: number, height: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  const clearance = distanceTransform(roi, barriers, width, height);
  const x0 = Math.round(width * 0.46);
  const x1 = Math.round(width * 0.54);
  const y0 = Math.round(height * 0.90);
  const y1 = Math.round(height * 0.96);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * width + x;
    if (!roi[i] || barriers[i]) continue;
    if (clearance[i] < 2) continue;
    const target = (x - width * 0.5) ** 2 + (y - height * 0.94) ** 2;
    if (target < bestDistance) { best = i; bestDistance = target; }
  }
  return best;
}

function distanceTransform(roi: Uint8Array, barriers: Uint8Array, width: number, height: number): Float32Array {
  // OpenCV DIST_L2 mask-size 3 chamfer approximation (axial=0.955, diagonal=1.3693).
  const distance = new Float32Array(roi.length);
  const axial = 0.955;
  const diagonal = 1.3693;
  for (let i = 0; i < distance.length; i++) distance[i] = roi[i] && !barriers[i] ? Infinity : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!distance[i]) continue;
    if (x > 0) distance[i] = Math.min(distance[i], distance[i - 1] + axial);
    if (y > 0) {
      distance[i] = Math.min(distance[i], distance[i - width] + axial);
      if (x > 0) distance[i] = Math.min(distance[i], distance[i - width - 1] + diagonal);
      if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i - width + 1] + diagonal);
    }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (!distance[i]) continue;
    if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + 1] + axial);
    if (y + 1 < height) {
      distance[i] = Math.min(distance[i], distance[i + width] + axial);
      if (x > 0) distance[i] = Math.min(distance[i], distance[i + width - 1] + diagonal);
      if (x + 1 < width) distance[i] = Math.min(distance[i], distance[i + width + 1] + diagonal);
    }
  }
  return distance;
}

function floodFill(roi: Uint8Array, barriers: Uint8Array, width: number, height: number, seed: number): Uint8Array {
  const filled = new Uint8Array(roi.length);
  const queue = new Int32Array(roi.length);
  let read = 0;
  let write = 0;
  queue[write++] = seed;
  filled[seed] = 1;
  while (read < write) {
    const i = queue[read++];
    const x = i % width;
    const y = Math.floor(i / width);
    if (x > 0) enqueue(i - 1);
    if (x + 1 < width) enqueue(i + 1);
    if (y > 0) enqueue(i - width);
    if (y + 1 < height) enqueue(i + width);
  }
  function enqueue(i: number): void {
    if (roi[i] && !barriers[i] && !filled[i]) { filled[i] = 1; queue[write++] = i; }
  }
  return filled;
}

function floodFillWasm(exports: FloodFillExports, roi: Uint8Array, barriers: Uint8Array,
  width: number, height: number, seed: number): Uint8Array {
  if (width <= 0 || height <= 0 || width * height !== roi.length ||
      barriers.length !== roi.length || seed < 0 || seed >= roi.length) {
    throw new RangeError('invalid flood-fill masks or geometry');
  }
  const len = roi.length;
  const pointers: number[] = [];
  try {
    for (const size of [len, len, len]) {
      const pointer = exports.alloc_bytes(size);
      if (!pointer) throw new Error('WASM allocation failed');
      pointers.push(pointer);
    }
    const allocatedQueuePointer = exports.alloc_words(len);
    if (!allocatedQueuePointer) throw new Error('WASM queue allocation failed');
    pointers.push(allocatedQueuePointer);
    const [roiPointer, barriersPointer, outputPointer] = pointers;
    const queuePointer = pointers[3];
    let memory = new Uint8Array(exports.memory.buffer);
    memory.set(roi, roiPointer);
    memory.set(barriers, barriersPointer);
    const count = exports.flood_fill(roiPointer, barriersPointer, outputPointer, queuePointer,
      len, seed, width, height);
    if (count < 0) throw new Error('WASM flood-fill rejected geometry');
    memory = new Uint8Array(exports.memory.buffer);
    return memory.slice(outputPointer, outputPointer + len);
  } finally {
    pointers.forEach((pointer, index) => {
      if (index === 3) exports.free_words(pointer, len);
      else exports.free_bytes(pointer, len);
    });
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }