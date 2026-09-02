const test = require("node:test");
const assert = require("node:assert/strict");
const selection = require("../src/shared/selection-model.js");
const maskModel = require("../src/shared/mask-model.js");

function makeMask(width, height, predicate) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (predicate(x, y)) mask[y * width + x] = 1;
    }
  }
  return mask;
}

test("selection session: starts empty and rejects mismatched masks", () => {
  const session = selection.createSelectionSession(4, 3);
  assert.equal(session.isEmpty(), true);
  assert.equal(session.count(), 0);
  assert.equal(session.setFromMask(new Uint8Array(5)), false);
  assert.equal(session.addMask(new Uint8Array(5)), false);
  assert.equal(session.subtractMask(new Uint8Array(5)), false);
});

test("selection session: add / subtract / invert state machine", () => {
  const width = 6;
  const height = 4;
  const session = selection.createSelectionSession(width, height);
  const left = makeMask(width, height, (x) => x < 2);
  const right = makeMask(width, height, (x) => x >= 4);

  assert.equal(session.addMask(left), true);
  assert.equal(session.count(), 2 * height);
  assert.equal(session.addMask(right), true);
  assert.equal(session.count(), 4 * height);

  const middle = makeMask(width, height, (x) => x === 3);
  session.subtractMask(middle);
  assert.equal(session.count(), 4 * height, "subtracting unselected area is a no-op");

  session.subtractMask(left);
  assert.equal(session.count(), 2 * height);

  session.invert();
  assert.equal(session.count(), (width - 2) * height, "invert selects everything else");

  session.clear();
  assert.equal(session.isEmpty(), true);
  session.invert();
  assert.equal(session.count(), width * height, "invert on empty selects all");
});

test("selection session: feathered mask produces soft transition with clamped radius", () => {
  const width = 21;
  const height = 5;
  const session = selection.createSelectionSession(width, height);
  assert.equal(selection.FEATHER_DEFAULT, 2);
  assert.equal(session.featherRadius, 2);
  assert.equal(session.setFeatherRadius(0), selection.FEATHER_MIN);
  assert.equal(session.setFeatherRadius(999), selection.FEATHER_MAX);
  session.setFeatherRadius(1);

  const left = makeMask(width, height, (x) => x < 10);
  session.setFromMask(left);
  const alpha = session.featheredMask();
  assert.equal(alpha[2 * width + 2], 255, "interior opaque");
  assert.equal(alpha[2 * width + 15], 0, "exterior transparent");
  const t1 = alpha[2 * width + 9];
  const t2 = alpha[2 * width + 10];
  assert.ok(t1 > 0 && t1 < 255 && t2 > 0 && t2 < 255, "soft edge exists");
  assert.ok(t1 > t2, "alpha falls off monotonically");
  // 显式半径覆盖会话半径
  const hard = session.featheredMask(0);
  assert.equal(hard[2 * width + 9], 255);
});

test("selection session: serialize / deserialize roundtrip", () => {
  const width = 8;
  const height = 8;
  const session = selection.createSelectionSession(width, height);
  session.setFromMask(makeMask(width, height, (x, y) => x >= 3 && y >= 2 && x < 6 && y < 7));
  session.setFeatherRadius(5);

  const state = session.serialize();
  assert.equal(state.version, selection.SELECTION_SERIALIZE_VERSION);
  assert.equal(state.width, width);
  assert.equal(state.height, height);
  assert.equal(state.featherRadius, 5);

  const other = selection.createSelectionSession(width, height);
  assert.equal(other.deserialize(state), true);
  assert.deepEqual(Array.from(other.getMask()), Array.from(session.getMask()));
  assert.equal(other.featherRadius, 5);

  const emptyState = selection.createSelectionSession(width, height).serialize();
  const emptyRestored = selection.createSelectionSession(width, height);
  assert.equal(emptyRestored.deserialize(emptyState), true);
  assert.equal(emptyRestored.isEmpty(), true);

  assert.equal(other.deserialize({ ...state, version: 99 }), false);
  assert.equal(other.deserialize({ ...state, width: 9 }), false);
  assert.equal(other.deserialize({ ...state, runs: [1, 999999] }), false);
  assert.equal(other.deserialize(null), false);
});

test("mask-model: stroke and selection actions share one undo stack", () => {
  const session = maskModel.createMaskSession();
  const stroke = { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] };
  const selectionAction = { type: "selection", alpha: new Uint8Array(4) };

  session.addStroke(stroke);
  session.addAction(selectionAction);
  assert.equal(session.strokes.length, 2);
  assert.equal(session.strokes[1].type, "selection");

  assert.deepEqual(session.undo(), selectionAction);
  assert.deepEqual(session.undo(), stroke);
  assert.equal(session.canUndo(), false);
  assert.deepEqual(session.redo(), stroke);
  assert.deepEqual(session.redo(), selectionAction);
  assert.equal(session.canRedo(), false);
});

test("mask-model: addAction enforces the 50-step cap and clears redo", () => {
  const session = maskModel.createMaskSession();
  for (let i = 0; i < 55; i += 1) {
    session.addAction({ type: "selection", seq: i });
  }
  assert.equal(session.strokes.length, maskModel.MASK_MAX_STEPS);
  assert.equal(session.strokes[0].seq, 5, "oldest actions dropped");
  session.undo();
  session.addAction({ type: "selection", seq: 100 });
  assert.equal(session.canRedo(), false);
  assert.equal(session.strokes[session.strokes.length - 1].seq, 100);
});
