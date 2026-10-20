export function packet(epoch = 7, sequence = 1) {
  const a = new Uint8Array(56);
  const d = new DataView(a.buffer);
  a.set(new TextEncoder().encode("VDX2"));
  d.setUint16(4, 1, true);
  d.setUint16(6, 52, true);
  d.setUint32(8, epoch, true);
  d.setUint32(12, sequence, true);
  a.set(new TextEncoder().encode("CAM2"), 24);
  d.setUint32(36, 4, true);
  d.setUint16(40, 320, true);
  d.setUint16(42, 240, true);
  a.set([255, 216, 255, 217], 52);
  return a.buffer;
}
