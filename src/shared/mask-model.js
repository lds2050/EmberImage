(function exposeMaskModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EmberImageMaskModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createMaskModel() {
  "use strict";

  const MASK_MAX_STEPS = 50;
  const MASK_BRUSH_MIN = 10;
  const MASK_BRUSH_MAX = 300;
  const MASK_BRUSH_DEFAULT = 80;

  function createMaskSession(initialStrokes) {
    const strokes = Array.isArray(initialStrokes) ? initialStrokes : [];
    const redoStack = [];

    return {
      strokes,
      addStroke(stroke) {
        if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return;
        strokes.push(stroke);
        if (strokes.length > MASK_MAX_STEPS) strokes.shift();
        redoStack.length = 0;
      },
      undo() {
        const stroke = strokes.pop();
        if (stroke) redoStack.push(stroke);
        return stroke || null;
      },
      redo() {
        const stroke = redoStack.pop();
        if (stroke) strokes.push(stroke);
        return stroke || null;
      },
      clear() {
        strokes.length = 0;
        redoStack.length = 0;
      },
      isEmpty() {
        return strokes.length === 0;
      },
      canUndo() {
        return strokes.length > 0;
      },
      canRedo() {
        return redoStack.length > 0;
      },
    };
  }

  return {
    MASK_BRUSH_DEFAULT,
    MASK_BRUSH_MAX,
    MASK_BRUSH_MIN,
    MASK_MAX_STEPS,
    createMaskSession,
  };
});
