const test = require("node:test");
const assert = require("node:assert/strict");
const algorithms = require("../src/shared/algorithms.js");

function makeBitmap(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function maskToPoints(mask, width) {
  const points = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) points.push([i % width, (i / width) | 0]);
  }
  return points;
}

test("similarityThreshold2: tolerance 0/128 boundary semantics", () => {
  assert.equal(algorithms.similarityThreshold2(0), 0);
  const max = algorithms.similarityThreshold2(128);
  assert.ok(max >= 255 * 255 * 3 - 1, "tolerance 128 covers full RGB distance");
  assert.ok(algorithms.similarityThreshold2(-5) === 0 && algorithms.similarityThreshold2(999) === max);
});

test("floodFill contiguous: selects connected region only", () => {
  // 左半红右半绿，中间列深红：连续模式从左侧种子不应跨过绿色
  const width = 5;
  const height = 3;
  const bitmap = makeBitmap(width, height, (x) => (x < 2 ? [200, 0, 0] : x === 2 ? [0, 200, 0] : [210, 10, 10]));
  const mask = algorithms.floodFill(bitmap, width, height, 0, 0, 64, { contiguous: true });
  assert.deepEqual(maskToPoints(mask, width), [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]);
});

test("floodFill global: picks similar pixels across gaps", () => {
  const width = 5;
  const height = 3;
  const bitmap = makeBitmap(width, height, (x) => (x === 0 || x === 4 ? [200, 0, 0] : [0, 200, 0]));
  const mask = algorithms.floodFill(bitmap, width, height, 0, 0, 10, { contiguous: false });
  assert.deepEqual(maskToPoints(mask, width), [[0, 0], [4, 0], [0, 1], [4, 1], [0, 2], [4, 2]]);
});

test("floodFill: tolerance boundary is inclusive and seed out of range is empty", () => {
  const width = 2;
  const height = 1;
  const bitmap = makeBitmap(width, height, (x) => (x === 0 ? [100, 100, 100] : [110, 110, 110]));
  // 距离 = sqrt(300) ≈ 17.32；容差 2 → 阈值 = 2/128*441.67 ≈ 6.9（不选）；容差 6 → ≈20.7（选）
  const strict = algorithms.floodFill(bitmap, width, height, 0, 0, 2, { contiguous: false });
  assert.equal(strict[1], 0);
  const loose = algorithms.floodFill(bitmap, width, height, 0, 0, 6, { contiguous: false });
  assert.equal(loose[1], 1);
  const none = algorithms.floodFill(bitmap, width, height, 99, 99, 128);
  assert.equal(none.length, width * height);
  assert.ok(none.every((v) => v === 0));
});

test("floodFill: pure color image selects everything", () => {
  const width = 64;
  const height = 64;
  const bitmap = makeBitmap(width, height, () => [7, 8, 9]);
  const mask = algorithms.floodFill(bitmap, width, height, 10, 10, 0);
  assert.equal(mask.length, width * height);
  assert.ok(mask.every((v) => v === 1));
});

test("floodFill: 4K-scale smoke run stays correct on gradient halves", () => {
  const width = 3840;
  const height = 2160;
  const bitmap = makeBitmap(width, height, (x) => (x < width / 2 ? [10, 20, 30] : [200, 210, 220]));
  const mask = algorithms.floodFill(bitmap, width, height, 0, 0, 5);
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i];
  assert.equal(count, (width / 2) * height);
});

test("fillPolygon: square, boundary pixel ownership and outside stays empty", () => {
  const width = 10;
  const height = 10;
  const square = [
    { x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 },
  ];
  const mask = algorithms.fillPolygon(square, width, height);
  assert.equal(mask[3 * width + 3], 1, "interior filled");
  assert.equal(mask[4 * width + 4], 1, "interior filled");
  assert.equal(mask[0], 0, "outside empty");
  assert.equal(mask[8 * width + 8], 0, "outside empty");
  // 像素中心在边界内：x∈[2,6) 即像素 2..5
  assert.equal(mask[3 * width + 2], 1);
  assert.equal(mask[3 * width + 5], 1);
  assert.equal(mask[3 * width + 6], 0);
});

test("fillPolygon: self-intersecting bowtie uses even-odd rule", () => {
  const width = 20;
  const height = 10;
  const bowtie = [
    { x: 1, y: 1 }, { x: 18, y: 9 }, { x: 18, y: 1 }, { x: 1, y: 9 },
  ];
  const mask = algorithms.fillPolygon(bowtie, width, height);
  const points = maskToPoints(mask, width);
  assert.ok(points.length > 0, "bowtie still fills some area");
  // 交叉点附近（中心 x≈9.5）以外两侧都应有填充
  assert.equal(mask[2 * width + 2], 1);
  assert.equal(mask[2 * width + 17], 1);
});

test("simplifyPolyline: keeps endpoints and honors the cap", () => {
  const points = [];
  for (let i = 0; i < 5000; i += 1) points.push({ x: i, y: i * 2 });
  const simplified = algorithms.simplifyPolyline(points, 2000);
  assert.ok(simplified.length <= 2000);
  assert.deepEqual(simplified[0], { x: 0, y: 0 });
  assert.deepEqual(simplified[simplified.length - 1], { x: 4999, y: 9998 });
  const untouched = algorithms.simplifyPolyline(points.slice(0, 100), 2000);
  assert.equal(untouched.length, 100);
});

test("convexHull: interior points removed, corners kept", () => {
  const hull = algorithms.convexHull([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 5, y: 5 }, { x: 4, y: 6 }, { x: 2, y: 3 },
  ]);
  assert.equal(hull.length, 4);
  const keys = new Set(hull.map((p) => `${p.x},${p.y}`));
  ["0,0", "10,0", "10,10", "0,10"].forEach((k) => assert.ok(keys.has(k), `missing ${k}`));
});

test("convexHullFromMask: fills hull of a plus-shaped mask", () => {
  const width = 9;
  const height = 9;
  const cross = new Uint8Array(width * height);
  for (let i = 0; i < width; i += 1) {
    cross[4 * width + i] = 1;
    cross[i * width + 4] = 1;
  }
  const filled = algorithms.convexHullFromMask(cross, width, height);
  assert.equal(filled[4 * width + 4], 1, "center filled");
  assert.equal(filled[3 * width + 3], 1, "hull corner region filled");
  assert.equal(filled[0], 0, "far corner stays empty");
});

test("sobelEdges: uniform image has no edges, step edge responds", () => {
  const width = 8;
  const height = 8;
  const flat = makeBitmap(width, height, () => [128, 128, 128]);
  const flatEdges = algorithms.sobelEdges(flat, width, height);
  assert.ok(flatEdges.every((v) => v === 0));
  const step = makeBitmap(width, height, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
  const edges = algorithms.sobelEdges(step, width, height);
  assert.equal(edges[1 * width + 1], 0, "far from edge");
  assert.equal(edges[1 * width + 2], 0, "column 2 adjacent to edge");
  assert.ok(edges[1 * width + 3] > 0, "boundary column responds");
  assert.ok(edges[1 * width + 4] > 0, "boundary column responds");
});

test("subjectMask: locates the synthetic subject, empty image yields empty mask", () => {
  const width = 40;
  const height = 40;
  const uniform = makeBitmap(width, height, () => [200, 200, 200]);
  assert.ok(algorithms.subjectMask(uniform, width, height, 30).every((v) => v === 0));
  const withSubject = makeBitmap(width, height, (x, y) => {
    const inside = x >= 12 && x < 26 && y >= 10 && y < 30;
    return inside ? [20, 30, 40] : [210, 205, 200];
  });
  const mask = algorithms.subjectMask(withSubject, width, height, 40);
  assert.equal(mask[15 * width + 15], 1, "inside subject selected");
  assert.equal(mask[2 * width + 2], 0, "background not selected");
  const points = maskToPoints(mask, width);
  assert.ok(points.length >= 14 * 20 - 4 && points.length <= 14 * 20 + 4, `subject area ≈ ${points.length}`);
  const hullFilled = algorithms.subjectMask(withSubject, width, height, 40, { fillHull: true });
  assert.equal(hullFilled[15 * width + 15], 1);
});

test("connectedComponents: two blobs counted with correct sizes", () => {
  const width = 10;
  const height = 10;
  const mask = new Uint8Array(width * height);
  mask[0] = 1; mask[1] = 1; mask[width] = 1;
  mask[8 * width + 8] = 1; mask[8 * width + 9] = 1; mask[9 * width + 9] = 1;
  const result = algorithms.connectedComponents(mask, width, height);
  assert.equal(result.count, 2);
  assert.deepEqual(result.sizes.slice().sort((a, b) => a - b), [3, 3]);
});

test("backgroundFromCorners: uniform image returns that color", () => {
  const width = 16;
  const height = 16;
  const bitmap = makeBitmap(width, height, () => [11, 22, 33]);
  assert.deepEqual(algorithms.backgroundFromCorners(bitmap, width, height, 4), [11, 22, 33]);
});

test("boxBlurChannel: radius 0 returns copy; blur softens edge monotonically", () => {
  const width = 21;
  const height = 5;
  const src = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 10; x += 1) src[y * width + x] = 255;
  }
  const copy = algorithms.boxBlurChannel(src, width, height, 0, 1);
  assert.deepEqual(Array.from(copy), Array.from(src));

  const blurred = algorithms.boxBlurChannel(src, width, height, 1, 1);
  assert.equal(blurred[2 * width + 2], 255, "deep interior stays 255");
  assert.equal(blurred[2 * width + 15], 0, "far exterior stays 0");
  // r=1 时过渡区在 x=9（170）、x=10（85）
  const t1 = blurred[2 * width + 9];
  const t2 = blurred[2 * width + 10];
  const t3 = blurred[2 * width + 11];
  assert.ok(t1 > 0 && t1 < 255, "transition value inside (0,255)");
  assert.ok(t1 > t2 && t2 >= t3 && t3 === 0, "monotonic fall-off across boundary");

  const wide = algorithms.boxBlurChannel(src, width, height, 20, 1);
  assert.ok(wide[2 * width + 10] > 0 && wide[2 * width + 10] < 255, "radius 20 still yields transition");
  const all255 = algorithms.boxBlurChannel(new Uint8Array(width * height).fill(255), width, height, 20, 1);
  assert.ok(all255.every((v) => v === 255), "uniform channel preserved (no dark edges)");
});
