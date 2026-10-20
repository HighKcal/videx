// Structural JPEG validation, not an entropy decoder. Only bounded 8-bit Huffman JPEGs.
export function validJpegDataUrl(image) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof image !== 'string' || image.length > 8_000_000 || !image.startsWith(prefix)) return false;
  const base64 = image.slice(prefix.length);
  if (!base64.length || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) return false;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64 || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
  let pos = 2, frame = false, scan = false, entropy = false, quantization = false, huffman = false;
  let components = new Set();
  while (pos < bytes.length) {
    if (bytes[pos++] !== 0xff) return false;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xd9) return frame && scan && entropy && pos === bytes.length;
    if (pos + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 11 || bytes[pos + 2] !== 8) return false;
      const height = bytes.readUInt16BE(pos + 3), width = bytes.readUInt16BE(pos + 5), count = bytes[pos + 7];
      if (![1, 3, 4].includes(count) || length !== 8 + 3 * count || !height || !width || height > 8192 || width > 8192 || height * width > 32_000_000) return false;
      components = new Set(Array.from({ length: count }, (_, i) => bytes[pos + 8 + i * 3]));
      if (components.size !== count) return false;
      frame = true;
    } else if (marker === 0xdb) {
      quantization = true;
    } else if (marker === 0xc4) {
      huffman = true;
    } else if (marker === 0xda) {
      const count = bytes[pos + 2];
      if (!frame || !quantization || !huffman || !count || count > components.size || length !== 6 + 2 * count) return false;
      for (let i = 0; i < count; i++) if (!components.has(bytes[pos + 3 + 2 * i])) return false;
      scan = true;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe && marker !== 0xdd) {
      return false;
    }
    pos += length;
    if (marker === 0xda) {
      while (pos < bytes.length) {
        if (bytes[pos] !== 0xff) { entropy = true; pos++; continue; }
        if (bytes[pos + 1] === 0 || (bytes[pos + 1] >= 0xd0 && bytes[pos + 1] <= 0xd7)) { entropy = true; pos += 2; continue; }
        break;
      }
    }
  }
  return false;
}
