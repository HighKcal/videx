import { describe, expect, it } from 'vitest';
import { ObstacleDetector } from '../src/vision/detector';

const WIDTH = 240;
const HEIGHT = 320;

function frame(blocked = false): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = 145;
    rgba[i * 4 + 1] = 145;
    rgba[i * 4 + 2] = 145;
    rgba[i * 4 + 3] = 255;
  }
  if (blocked) {
    for (let y = 165; y <= 260; y++) for (let x = 82; x <= 158; x++) {
      const i = (y * WIDTH + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 25;
    }
  }
  return rgba;
}

function resizeNearest(source: Uint8ClampedArray, sourceWidth: number, sourceHeight: number,
  width: number, height: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(y * sourceHeight / height) * sourceWidth + Math.floor(x * sourceWidth / width)) * 4;
    output.set(source.subarray(from, from + 4), (y * width + x) * 4);
  }
  return output;
}

describe('ObstacleDetector Python-baseline regression', () => {
  it('returns a clear-floor monitoring candidate, never a safety claim', () => {
    const result = new ObstacleDetector().analyze(frame(), WIDTH, HEIGHT, 10);
    expect(result.state).toBe('MONITORING');
    expect(result.total).toBeLessThan(0.18);
    expect(result.reason).toContain('not proof of a clear path');
  });

  it('confirms an enclosed central obstacle only after three distinct frames', () => {
    const detector = new ObstacleDetector();
    const first = detector.analyze(frame(true), WIDTH, HEIGHT, 0);
    const second = detector.analyze(frame(true), WIDTH, HEIGHT, 100);
    const third = detector.analyze(frame(true), WIDTH, HEIGHT, 200);
    // Python's exact synthetic(30) baseline: state candidate and both thresholds.
    expect(first.state).toBe('MONITORING');
    expect(first.total).toBeGreaterThanOrEqual(0.18);
    expect(first.central).toBeGreaterThanOrEqual(0.3);
    expect(second.state).toBe('MONITORING');
    expect(third.state).toBe('WARNING');
  });

  it('holds a warning until three consecutive clear frames', () => {
    const detector = new ObstacleDetector();
    for (let i = 0; i < 3; i++) detector.analyze(frame(true), WIDTH, HEIGHT, i * 100);
    expect(detector.analyze(frame(), WIDTH, HEIGHT, 300).state).toBe('WARNING');
    expect(detector.analyze(frame(), WIDTH, HEIGHT, 400).state).toBe('WARNING');
    expect(detector.analyze(frame(), WIDTH, HEIGHT, 500).state).toBe('MONITORING');
  });

  it('does not count duplicate buffer/timestamp as a new confirmation', () => {
    const detector = new ObstacleDetector();
    const same = frame(true);
    expect(detector.analyze(same, WIDTH, HEIGHT, 0).state).toBe('MONITORING');
    expect(detector.analyze(same, WIDTH, HEIGHT, 0).state).toBe('MONITORING');
    expect(detector.analyze(frame(true), WIDTH, HEIGHT, 100).state).toBe('MONITORING');
    expect(detector.analyze(frame(true), WIDTH, HEIGHT, 200).state).toBe('WARNING');
  });

  it('fails closed for malformed, dark, bright, too-small and stale input', () => {
    const detector = new ObstacleDetector();
    expect(detector.analyze(new Uint8ClampedArray(3), WIDTH, HEIGHT, 0).state).toBe('UNKNOWN');
    const dark = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    expect(detector.analyze(dark, WIDTH, HEIGHT, 1).state).toBe('UNKNOWN');
    const bright = frame();
    for (let i = 0; i < bright.length; i += 4) bright[i] = bright[i + 1] = bright[i + 2] = 255;
    expect(detector.analyze(bright, WIDTH, HEIGHT, 2).state).toBe('UNKNOWN');
    expect(detector.analyze(frame(), 16, 16, 3).state).toBe('UNKNOWN');
    const valid = frame();
    detector.analyze(valid, WIDTH, HEIGHT, 4);
    expect(detector.markStale(2005).state).toBe('UNKNOWN');
  });

  it('requires three new confirmations after a resolution change', () => {
    const detector = new ObstacleDetector();
    for (let i = 0; i < 3; i++) detector.analyze(frame(true), WIDTH, HEIGHT, i * 100);
    const resizedWidth = WIDTH * 2;
    const resized = resizeNearest(frame(true), WIDTH, HEIGHT, resizedWidth, HEIGHT);
    expect(detector.analyze(resized, resizedWidth, HEIGHT, 300).state).toBe('MONITORING');
    expect(detector.analyze(new Uint8ClampedArray(4), resizedWidth, HEIGHT, 301).state).toBe('UNKNOWN');
  });

  it('resets confirmation on a stale inter-frame gap without a timer callback', () => {
    const detector = new ObstacleDetector();
    detector.analyze(frame(true), WIDTH, HEIGHT, 0);
    detector.analyze(frame(true), WIDTH, HEIGHT, 100);
    expect(detector.analyze(frame(true), WIDTH, HEIGHT, 2201).state).toBe('MONITORING');
    expect(detector.analyze(frame(true), WIDTH, HEIGHT, 2301).state).toBe('MONITORING');
    expect(detector.analyze(frame(true), WIDTH, HEIGHT, 2401).state).toBe('WARNING');
  });

  it('does not make monocular distance or safety claims', () => {
    const detector = new ObstacleDetector();
    expect(Object.keys(detector.analyze(frame(), WIDTH, HEIGHT, 0)).sort())
      .toEqual(['central', 'reason', 'state', 'total']);
  });
});
