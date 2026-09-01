(function exposeExif(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ImageStudioExif = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createExif() {
  "use strict";

  function jpegOrientation(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xda) return null;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) return null;
      const segmentEnd = offset + 2 + length;
      if (marker === 0xe1 && length >= 8) {
        const payload = offset + 4;
        if (
          bytes[payload] === 0x45 && bytes[payload + 1] === 0x78 &&
          bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66 &&
          bytes[payload + 4] === 0x00 && bytes[payload + 5] === 0x00
        ) {
          return parseTiffOrientation(bytes, payload + 6, segmentEnd);
        }
      }
      offset = segmentEnd;
    }
    return null;
  }

  function parseTiffOrientation(bytes, tiffStart, limit) {
    if (tiffStart + 8 > limit) return null;
    const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
    const big = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
    if (!little && !big) return null;
    const read16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
    const read32 = (o) =>
      little
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    if (read16(tiffStart + 2) !== 42) return null;
    const ifd = tiffStart + read32(tiffStart + 4);
    if (ifd + 2 > limit) return null;
    const count = read16(ifd);
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > limit) return null;
      if (read16(entry) === 0x0112) {
        const value = read16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
    return null;
  }

  function buildJpegWithOrientation(bytes, orientation) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Not a JPEG buffer");
    }
    const tiff = new Uint8Array(26);
    const view = new DataView(tiff.buffer);
    tiff[0] = 0x49;
    tiff[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 1, true);
    view.setUint16(10, 0x0112, true);
    view.setUint16(12, 3, true);
    view.setUint32(14, 1, true);
    view.setUint16(18, orientation, true);
    view.setUint32(22, 0, true);
    const segment = new Uint8Array(4 + 6 + tiff.length);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment[2] = 0x00;
    segment[3] = segment.length - 2;
    segment[4] = 0x45;
    segment[5] = 0x78;
    segment[6] = 0x69;
    segment[7] = 0x66;
    segment[8] = 0x00;
    segment[9] = 0x00;
    segment.set(tiff, 10);
    const out = new Uint8Array(2 + segment.length + (bytes.length - 2));
    out.set(bytes.subarray(0, 2), 0);
    out.set(segment, 2);
    out.set(bytes.subarray(2), 2 + segment.length);
    return out;
  }

  function transformBitmap(buffer, width, height, orientation) {
    if (orientation === 1 || orientation == null) return { buffer, width, height };
    const rotated = orientation >= 5;
    const outWidth = rotated ? height : width;
    const outHeight = rotated ? width : height;
    const out = Buffer.allocUnsafe(outWidth * outHeight * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let dx;
        let dy;
        switch (orientation) {
          case 2: dx = width - 1 - x; dy = y; break;
          case 3: dx = width - 1 - x; dy = height - 1 - y; break;
          case 4: dx = x; dy = height - 1 - y; break;
          case 5: dx = y; dy = x; break;
          case 6: dx = height - 1 - y; dy = x; break;
          case 7: dx = height - 1 - y; dy = width - 1 - x; break;
          default: dx = y; dy = width - 1 - x; break;
        }
        buffer.copy(out, (dy * outWidth + dx) * 4, (y * width + x) * 4, (y * width + x) * 4 + 4);
      }
    }
    return { buffer: out, width: outWidth, height: outHeight };
  }

  return {
    buildJpegWithOrientation,
    jpegOrientation,
    transformBitmap,
  };
});
