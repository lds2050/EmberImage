(function exposeAlgorithms(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EmberImageAlgorithms = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAlgorithms() {
  "use strict";

  const TOLERANCE_MAX = 128;

  // 容差 0..128 映射到 RGB 欧氏距离 0..441.7（sqrt(3)*255）。
  // 容差 128 时全图任意颜色都相似，容差 0 仅完全相同。
  function similarityThreshold2(tolerance) {
    const clamped = Math.max(0, Math.min(TOLERANCE_MAX, Number(tolerance) || 0));
    const maxDist = 255 * Math.sqrt(3);
    const dist = (clamped / TOLERANCE_MAX) * maxDist;
    return dist * dist;
  }

  function colorDistance2(bitmap, index, r, g, b) {
    const dr = bitmap[index * 4] - r;
    const dg = bitmap[index * 4 + 1] - g;
    const db = bitmap[index * 4 + 2] - b;
    return dr * dr + dg * dg + db * db;
  }

  // 魔棒：连续模式为种子扩散（4 邻接 BFS），全图模式为逐像素比对。
  // bitmap 为 RGBA Uint8Array/Uint8ClampedArray；返回 Uint8Array（0/1，每像素一字节）。
  function floodFill(bitmap, width, height, seedX, seedY, tolerance, options) {
    const out = new Uint8Array(width * height);
    if (!bitmap || width <= 0 || height <= 0) return out;
    const x0 = Math.floor(seedX);
    const y0 = Math.floor(seedY);
    if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return out;
    const seedIndex = y0 * width + x0;
    const sr = bitmap[seedIndex * 4];
    const sg = bitmap[seedIndex * 4 + 1];
    const sb = bitmap[seedIndex * 4 + 2];
    const threshold2 = similarityThreshold2(tolerance);
    const contiguous = !options || options.contiguous !== false;
    const matches = (i) => colorDistance2(bitmap, i, sr, sg, sb) <= threshold2;

    if (!contiguous) {
      for (let i = 0; i < out.length; i += 1) {
        out[i] = matches(i) ? 1 : 0;
      }
      return out;
    }

    const stack = [seedIndex];
    out[seedIndex] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) {
        const n = i - 1;
        if (!out[n] && matches(n)) { out[n] = 1; stack.push(n); }
      }
      if (x < width - 1) {
        const n = i + 1;
        if (!out[n] && matches(n)) { out[n] = 1; stack.push(n); }
      }
      if (y > 0) {
        const n = i - width;
        if (!out[n] && matches(n)) { out[n] = 1; stack.push(n); }
      }
      if (y < height - 1) {
        const n = i + width;
        if (!out[n] && matches(n)) { out[n] = 1; stack.push(n); }
      }
    }
    return out;
  }

  // 套索：扫描线 + 奇偶规则填充多边形（像素中心采样，自交路径天然支持）。
  function fillPolygon(points, width, height) {
    const out = new Uint8Array(width * height);
    if (!Array.isArray(points) || points.length < 3 || width <= 0 || height <= 0) return out;
    const edges = [];
    for (let i = 0; i < points.length; i += 1) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      if (p1.y !== p2.y) edges.push([p1.x, p1.y, p2.x, p2.y]);
    }
    if (!edges.length) return out;
    for (let y = 0; y < height; y += 1) {
      const cy = y + 0.5;
      const xs = [];
      for (let e = 0; e < edges.length; e += 1) {
        const ex1 = edges[e][0];
        const ey1 = edges[e][1];
        const ex2 = edges[e][2];
        const ey2 = edges[e][3];
        if ((ey1 <= cy && ey2 > cy) || (ey2 <= cy && ey1 > cy)) {
          xs.push(ex1 + ((cy - ey1) / (ey2 - ey1)) * (ex2 - ex1));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x += 1) {
          out[y * width + x] = 1;
        }
      }
    }
    return out;
  }

  // 顶点抽稀：路径超出上限时均匀保留点（含首尾）。
  function simplifyPolyline(points, maxVertices) {
    if (!Array.isArray(points) || points.length <= 0) return [];
    const limit = Math.max(3, maxVertices || 2000);
    if (points.length <= limit) return points.slice();
    const step = Math.ceil((points.length - 1) / (limit - 1));
    const out = [];
    for (let i = 0; i < points.length; i += step) {
      out.push(points[i]);
    }
    const last = points[points.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  // Andrew 单调链凸包；输入点集，返回逆时针凸包顶点。
  function convexHull(points) {
    if (!Array.isArray(points) || points.length < 3) return (points || []).slice();
    const sorted = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (let i = 0; i < sorted.length; i += 1) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
        lower.pop();
      }
      lower.push(sorted[i]);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) {
        upper.pop();
      }
      upper.push(sorted[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // 从二值蒙版提取边界点，凸包化后填充（用于自动主体的平滑近似）。
  function convexHullFromMask(mask, width, height) {
    if (!mask || width <= 0 || height <= 0) return new Uint8Array(width * height);
    const boundary = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const left = x > 0 ? mask[i - 1] : 0;
        const right = x < width - 1 ? mask[i + 1] : 0;
        const up = y > 0 ? mask[i - width] : 0;
        const down = y < height - 1 ? mask[i + width] : 0;
        if (!left || !right || !up || !down) boundary.push({ x, y });
      }
    }
    if (boundary.length < 3) {
      const out = new Uint8Array(width * height);
      out.set(mask.subarray(0, Math.min(mask.length, out.length)));
      return out;
    }
    return fillPolygon(convexHull(boundary), width, height);
  }

  // Sobel 边缘：输入 RGBA，输出单通道灰度边缘强度（0..255）。
  function sobelEdges(bitmap, width, height) {
    const out = new Uint8Array(width * height);
    if (!bitmap || width < 3 || height < 3) return out;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = 0.299 * bitmap[i * 4] + 0.587 * bitmap[i * 4 + 1] + 0.114 * bitmap[i * 4 + 2];
    }
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        const tl = gray[i - width - 1];
        const t = gray[i - width];
        const tr = gray[i - width + 1];
        const l = gray[i - 1];
        const r = gray[i + 1];
        const bl = gray[i + width - 1];
        const b = gray[i + width];
        const br = gray[i + width + 1];
        const gx = -tl - 2 * l - bl + tr + 2 * r + br;
        const gy = -tl - 2 * t - tr + bl + 2 * b + br;
        out[i] = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      }
    }
    return out;
  }

  // 盒式模糊（单通道 0..255）：分离水平/垂直两趟，窗口在边缘处收缩，亮度守恒。
  // iterations >= 1，多次迭代近似高斯；radius 0 时返回副本。
  function boxBlurChannel(src, width, height, radius, iterations) {
    const out = new Uint8Array(width * height);
    if (!src || width <= 0 || height <= 0) return out;
    const r = Math.max(0, Math.min(64, Math.floor(radius) || 0));
    const iterCount = Math.max(1, Math.min(4, Math.floor(iterations) || 1));
    if (r === 0) {
      out.set(src.subarray(0, Math.min(src.length, out.length)));
      return out;
    }
    let current = Uint8Array.from(src.subarray(0, width * height));
    let temp = new Uint8Array(width * height);
    for (let iter = 0; iter < iterCount; iter += 1) {
      // 水平
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        let sum = 0;
        for (let x = -r; x <= r; x += 1) sum += current[row + Math.min(width - 1, Math.max(0, x))];
        for (let x = 0; x < width; x += 1) {
          temp[row + x] = Math.round(sum / (2 * r + 1));
          const outIdx = Math.max(0, x - r);
          const inIdx = Math.min(width - 1, x + r + 1);
          sum += current[row + inIdx] - current[row + outIdx];
        }
      }
      // 垂直
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let y = -r; y <= r; y += 1) sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
        for (let y = 0; y < height; y += 1) {
          current[y * width + x] = Math.round(sum / (2 * r + 1));
          const outIdx = Math.max(0, y - r);
          const inIdx = Math.min(height - 1, y + r + 1);
          sum += temp[inIdx * width + x] - temp[outIdx * width + x];
        }
      }
    }
    out.set(current);
    return out;
  }

  // 4 邻接连通域标记；mask 为 0/1。返回 { labels, sizes, count }。
  function connectedComponents(mask, width, height) {
    const labels = new Int32Array(width * height);
    labels.fill(-1);
    const sizes = [];
    if (!mask || width <= 0 || height <= 0) return { labels, sizes, count: 0 };
    let count = 0;
    const stack = [];
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || labels[start] !== -1) continue;
      const label = count;
      let size = 0;
      labels[start] = label;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        size += 1;
        const x = i % width;
        const y = (i / width) | 0;
        if (x > 0 && mask[i - 1] && labels[i - 1] === -1) { labels[i - 1] = label; stack.push(i - 1); }
        if (x < width - 1 && mask[i + 1] && labels[i + 1] === -1) { labels[i + 1] = label; stack.push(i + 1); }
        if (y > 0 && mask[i - width] && labels[i - width] === -1) { labels[i - width] = label; stack.push(i - width); }
        if (y < height - 1 && mask[i + width] && labels[i + width] === -1) { labels[i + width] = label; stack.push(i + width); }
      }
      sizes.push(size);
      count += 1;
    }
    return { labels, sizes, count };
  }

  // 背景色估计：四角 patch 均值。
  function backgroundFromCorners(bitmap, width, height, patchSize) {
    const patch = Math.max(1, patchSize || 8);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const corners = [
      [0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch],
    ];
    for (let c = 0; c < corners.length; c += 1) {
      const cx = Math.max(0, Math.min(width - patch, corners[c][0]));
      const cy = Math.max(0, Math.min(height - patch, corners[c][1]));
      for (let y = cy; y < cy + patch; y += 1) {
        for (let x = cx; x < cx + patch; x += 1) {
          const i = (y * width + x) * 4;
          r += bitmap[i];
          g += bitmap[i + 1];
          b += bitmap[i + 2];
          n += 1;
        }
      }
    }
    if (!n) return [0, 0, 0];
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  // 自动主体：与背景色不相似的像素 → 最大连通域（可选凸包近似）。
  function subjectMask(bitmap, width, height, tolerance, options) {
    const opts = options || {};
    if (!bitmap || width <= 0 || height <= 0) return new Uint8Array(Math.max(0, width * height));
    const bg = backgroundFromCorners(bitmap, width, height, opts.patchSize);
    const threshold2 = similarityThreshold2(tolerance);
    const binary = new Uint8Array(width * height);
    for (let i = 0; i < binary.length; i += 1) {
      binary[i] = colorDistance2(bitmap, i, bg[0], bg[1], bg[2]) > threshold2 ? 1 : 0;
    }
    const { labels, sizes, count } = connectedComponents(binary, width, height);
    if (!count) return new Uint8Array(width * height);
    let largest = 0;
    for (let label = 1; label < count; label += 1) {
      if (sizes[label] > sizes[largest]) largest = label;
    }
    const out = new Uint8Array(width * height);
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] === largest) out[i] = 1;
    }
    return opts.fillHull ? convexHullFromMask(out, width, height) : out;
  }

  return {
    TOLERANCE_MAX,
    backgroundFromCorners,
    boxBlurChannel,
    connectedComponents,
    convexHull,
    convexHullFromMask,
    fillPolygon,
    floodFill,
    similarityThreshold2,
    simplifyPolyline,
    sobelEdges,
    subjectMask,
  };
});
