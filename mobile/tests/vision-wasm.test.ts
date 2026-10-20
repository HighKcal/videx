import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initializeVision, visionRuntimeStatus, floodFillMask } from '../src/vision/detector';

describe('vision WebAssembly flood-fill kernel', () => {
  it('instantiates the checked-in module and matches the JavaScript mask', async () => {
    const artifact = await readFile(fileURLToPath(new URL('../src/vision/flood_fill.wasm', import.meta.url)));
    const exactBytes = artifact.buffer.slice(artifact.byteOffset, artifact.byteOffset + artifact.byteLength);
    const status = await initializeVision(exactBytes);
    expect(status).toBe('wasm');
    expect(visionRuntimeStatus()).toBe('wasm');
    const roi = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const barriers = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const expected = floodFillMask(roi, barriers, 3, 3, 0);
    const detector = await import('../src/vision/detector');
    const actual = detector.floodFillMaskWasm(roi, barriers, 3, 3, 0);
    expect(Array.from(actual)).toEqual(Array.from(expected));
    expect(Array.from(actual)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  });

  it('keeps JavaScript available when a module load fails', async () => {
    const status = await initializeVision(new URL('file:///definitely-missing-videx-kernel.wasm'));
    expect(status).toBe('javascript');
    expect(visionRuntimeStatus()).toBe('javascript');
    const roi = new Uint8Array([1, 1, 1]);
    expect(Array.from((await import('../src/vision/detector'))
      .floodFillMaskWasm(roi, new Uint8Array(3), 3, 1, 0))).toEqual([1, 1, 1]);
  });
});
