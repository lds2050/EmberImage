// 选区计算 Worker：像素密集计算（魔棒 flood fill / 套索多边形填充 / 自动主体）移出主线程。
// 说明：file:// 协议下 module worker 受 CORS 限制，因此使用经典 worker + importScripts
// 复用 src/shared/algorithms.js（与渲染层主线程降级路径共享同一份算法实现）。
"use strict";

importScripts("../../shared/algorithms.js");

const Algorithms = self.EmberImageAlgorithms;

// 编辑器打开时由渲染层推入的主图原始尺寸 RGBA 位图（独立副本，随 postMessage 转移所有权）。
let bitmap = null;
let bitmapWidth = 0;
let bitmapHeight = 0;

function postMask(id, mask) {
  self.postMessage({ id, ok: true, mask }, [mask.buffer]);
}

self.onmessage = (event) => {
  const { id, op, payload } = event.data || {};
  if (!id || !op) return;
  try {
    if (op === "setBitmap") {
      bitmap = new Uint8Array(payload.bitmap);
      bitmapWidth = payload.width | 0;
      bitmapHeight = payload.height | 0;
      self.postMessage({ id, ok: true });
      return;
    }
    if (op === "floodFill") {
      postMask(id, Algorithms.floodFill(bitmap, bitmapWidth, bitmapHeight, payload.x, payload.y, payload.tolerance, { contiguous: payload.contiguous !== false }));
      return;
    }
    if (op === "fillPolygon") {
      postMask(id, Algorithms.fillPolygon(payload.points, payload.width | 0, payload.height | 0));
      return;
    }
    if (op === "subjectMask") {
      // 编辑器内走 setBitmap 推入的主图；背景移除等独立流程直接携带位图（payload.bitmap）。
      const source = payload.bitmap ? new Uint8Array(payload.bitmap) : bitmap;
      const w = payload.bitmap ? payload.width | 0 : bitmapWidth;
      const h = payload.bitmap ? payload.height | 0 : bitmapHeight;
      postMask(id, Algorithms.subjectMask(source, w, h, payload.tolerance, { fillHull: payload.fillHull === true, patchSize: payload.patchSize, maxEdge: payload.maxEdge | 0 }));
      return;
    }
    throw new Error(`未知选区操作：${op}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: (error && error.message) || String(error) });
  }
};
