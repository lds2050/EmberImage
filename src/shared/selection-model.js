(function exposeSelectionModel(root, factory) {
  let Algorithms;
  if (typeof module === "object" && module.exports) {
    Algorithms = require("./algorithms.js");
  }
  const api = factory(Algorithms || (root ? root.EmberImageAlgorithms : undefined));
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EmberImageSelectionModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSelectionModelModule(Algorithms) {
  "use strict";

  if (!Algorithms || typeof Algorithms.boxBlurChannel !== "function") {
    throw new Error("EmberImageSelectionModel requires EmberImageAlgorithms");
  }

  const FEATHER_MIN = 1;
  const FEATHER_MAX = 20;
  const FEATHER_DEFAULT = 2;
  const SELECTION_SERIALIZE_VERSION = 1;

  function clampFeather(radius) {
    const value = Math.floor(Number(radius));
    if (!Number.isFinite(value)) return FEATHER_DEFAULT;
    return Math.max(FEATHER_MIN, Math.min(FEATHER_MAX, value));
  }

  // 纯函数：解码序列化状态（runs 行程编码）为二值蒙版。
  // 供渲染层/导出层重建"已应用为 Mask"的选区动作；state 无效时返回 null。
  function decodeSelectionRuns(state, size) {
    const total = Math.max(0, size | 0);
    if (!state || !Array.isArray(state.runs) || state.runs.length < 2) return null;
    const out = new Uint8Array(total);
    let cursor = 0;
    let value = state.runs[0] ? 1 : 0;
    for (let r = 1; r < state.runs.length; r += 1) {
      const length = state.runs[r] | 0;
      if (length < 0 || cursor + length > total) return null;
      if (value) out.fill(1, cursor, cursor + length);
      cursor += length;
      value = value ? 0 : 1;
    }
    if (cursor !== total) return null;
    return out;
  }

  // 选区会话：持有全尺寸二值蒙版（0/1）与羽化半径；羽化在"应用为 Mask"时产出 0..255 Alpha。
  function createSelectionSession(width, height, options) {
    const opts = options || {};
    const size = Math.max(0, (width | 0) * (height | 0));
    let baseMask = new Uint8Array(size);
    let featherRadius = clampFeather(opts.featherRadius != null ? opts.featherRadius : FEATHER_DEFAULT);

    const validMask = (mask) => mask && mask.length === size;

    return {
      width: width | 0,
      height: height | 0,
      get featherRadius() { return featherRadius; },
      setFeatherRadius(radius) {
        featherRadius = clampFeather(radius);
        return featherRadius;
      },
      getMask() {
        return baseMask.slice();
      },
      setFromMask(mask) {
        if (!validMask(mask)) return false;
        baseMask.set(mask);
        return true;
      },
      addMask(mask) {
        if (!validMask(mask)) return false;
        for (let i = 0; i < size; i += 1) {
          if (mask[i]) baseMask[i] = 1;
        }
        return true;
      },
      subtractMask(mask) {
        if (!validMask(mask)) return false;
        for (let i = 0; i < size; i += 1) {
          if (mask[i]) baseMask[i] = 0;
        }
        return true;
      },
      invert() {
        for (let i = 0; i < size; i += 1) {
          baseMask[i] = baseMask[i] ? 0 : 1;
        }
      },
      clear() {
        baseMask.fill(0);
      },
      isEmpty() {
        for (let i = 0; i < size; i += 1) {
          if (baseMask[i]) return false;
        }
        return true;
      },
      count() {
        let n = 0;
        for (let i = 0; i < size; i += 1) n += baseMask[i];
        return n;
      },
      // 羽化后的选区 Alpha（0..255）：二值蒙版放大到 0/255 后经盒式模糊得到柔和边界。
      // 显式传 radius=0 表示不羽化（硬边界）；会话状态半径始终在 FEATHER_MIN..MAX。
      featheredMask(radius) {
        const scaled = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) {
          scaled[i] = baseMask[i] ? 255 : 0;
        }
        const requested = radius != null ? Math.floor(Number(radius)) : featherRadius;
        if (requested === 0) return scaled;
        const r = clampFeather(requested);
        return Algorithms.boxBlurChannel(scaled, width | 0, height | 0, r, 1);
      },
      // 行程编码序列化：{ version, width, height, featherRadius, runs }。
      // runs[0] 为起始值（0/1），其后交替为各段长度；空选区 runs = [0, size]。
      serialize() {
        const runs = [baseMask[0] ? 1 : 0];
        let current = baseMask[0] ? 1 : 0;
        let runLength = 0;
        for (let i = 0; i < size; i += 1) {
          const value = baseMask[i] ? 1 : 0;
          if (value === current) {
            runLength += 1;
          } else {
            runs.push(runLength);
            current = value;
            runLength = 1;
          }
        }
        runs.push(runLength);
        return {
          version: SELECTION_SERIALIZE_VERSION,
          width: width | 0,
          height: height | 0,
          featherRadius,
          runs,
        };
      },
      deserialize(state) {
        if (!state || state.version !== SELECTION_SERIALIZE_VERSION) return false;
        if ((state.width | 0) !== (width | 0) || (state.height | 0) !== (height | 0)) return false;
        const restored = decodeSelectionRuns(state, size);
        if (!restored) return false;
        baseMask = restored;
        featherRadius = clampFeather(state.featherRadius);
        return true;
      },
    };
  }

  return {
    FEATHER_DEFAULT,
    FEATHER_MAX,
    FEATHER_MIN,
    SELECTION_SERIALIZE_VERSION,
    createSelectionSession,
    decodeSelectionRuns,
  };
});
