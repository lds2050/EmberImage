"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Exif = require("../src/shared/exif.js");

function bareJpeg() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02]);
}

test("jpegOrientation returns null for non-JPEG buffers", () => {
  assert.equal(Exif.jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(Exif.jpegOrientation(new Uint8Array([0xff])), null);
  assert.equal(Exif.jpegOrientation(null), null);
});

test("jpegOrientation returns null for JPEG without EXIF", () => {
  assert.equal(Exif.jpegOrientation(bareJpeg()), null);
});

test("jpegOrientation round-trips every orientation written by buildJpegWithOrientation", () => {
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const jpeg = Exif.buildJpegWithOrientation(bareJpeg(), orientation);
    assert.equal(Exif.jpegOrientation(jpeg), orientation, `orientation ${orientation}`);
  }
});

test("jpegOrientation handles a big-endian TIFF header", () => {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x4d;
  tiff[1] = 0x4d;
  view.setUint16(2, 42, false);
  view.setUint32(4, 8, false);
  view.setUint16(8, 1, false);
  view.setUint16(10, 0x0112, false);
  view.setUint16(12, 3, false);
  view.setUint32(14, 1, false);
  view.setUint16(18, 3, false);
  const segment = new Uint8Array(4 + 6 + tiff.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[3] = segment.length - 2;
  segment.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  segment.set(tiff, 10);
  const out = new Uint8Array(2 + segment.length);
  out.set([0xff, 0xd8], 0);
  out.set(segment, 2);
  assert.equal(Exif.jpegOrientation(out), 3);
});

test("jpegOrientation returns null for truncated EXIF payloads", () => {
  const jpeg = Exif.buildJpegWithOrientation(bareJpeg(), 6);
  assert.equal(Exif.jpegOrientation(jpeg.slice(0, 12)), null);
  assert.equal(Exif.jpegOrientation(jpeg.slice(0, 30)), null);
});

test("buildJpegWithOrientation rejects non-JPEG buffers", () => {
  assert.throws(() => Exif.buildJpegWithOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 6));
});

function pixelBuffer(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const buffer = Buffer.alloc(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((label, x) => {
    buffer[(y * width + x) * 4 + 3] = 255;
    buffer[(y * width + x) * 4] = label.charCodeAt(0);
  }));
  return { buffer, width, height };
}

function labels(result) {
  const rows = [];
  for (let y = 0; y < result.height; y += 1) {
    let row = "";
    for (let x = 0; x < result.width; x += 1) row += String.fromCharCode(result.buffer[(y * result.width + x) * 4]);
    rows.push(row);
  }
  return rows;
}

test("transformBitmap passes orientation 1 and null through unchanged", () => {
  const { buffer, width, height } = pixelBuffer(["AB", "CD"]);
  for (const orientation of [1, null]) {
    const result = Exif.transformBitmap(buffer, width, height, orientation);
    assert.equal(result.width, 2);
    assert.equal(result.height, 2);
    assert.deepEqual(labels(result), ["AB", "CD"]);
  }
});

test("transformBitmap mirrors horizontally for orientation 2", () => {
  const { buffer, width, height } = pixelBuffer(["AB", "CD"]);
  assert.deepEqual(labels(Exif.transformBitmap(buffer, width, height, 2)), ["BA", "DC"]);
});

test("transformBitmap rotates 180 degrees for orientation 3", () => {
  const { buffer, width, height } = pixelBuffer(["AB", "CD"]);
  assert.deepEqual(labels(Exif.transformBitmap(buffer, width, height, 3)), ["DC", "BA"]);
});

test("transformBitmap rotates 90 degrees clockwise for orientation 6 and swaps dimensions", () => {
  const { buffer, width, height } = pixelBuffer(["ABC", "DEF"]);
  const result = Exif.transformBitmap(buffer, width, height, 6);
  assert.equal(result.width, 2);
  assert.equal(result.height, 3);
  assert.deepEqual(labels(result), ["DA", "EB", "FC"]);
});

test("transformBitmap transposes for orientation 5", () => {
  const { buffer, width, height } = pixelBuffer(["ABC", "DEF"]);
  const result = Exif.transformBitmap(buffer, width, height, 5);
  assert.equal(result.width, 2);
  assert.equal(result.height, 3);
  assert.deepEqual(labels(result), ["AD", "BE", "CF"]);
});
