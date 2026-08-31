"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const MaskModel = require("../src/shared/mask-model.js");

function stroke(tool, id) {
  return { tool, radius: 80, points: [{ x: id, y: id }, { x: id + 1, y: id + 1 }] };
}

test("mask session records strokes and reports empty state", () => {
  const session = MaskModel.createMaskSession();
  assert.equal(session.isEmpty(), true);
  session.addStroke(stroke("brush", 1));
  assert.equal(session.isEmpty(), false);
  assert.equal(session.strokes.length, 1);
  assert.equal(session.canUndo(), true);
  assert.equal(session.canRedo(), false);
});

test("undo and redo move strokes between stacks", () => {
  const session = MaskModel.createMaskSession();
  session.addStroke(stroke("brush", 1));
  session.addStroke(stroke("eraser", 2));

  const undone = session.undo();
  assert.equal(undone.points[0].x, 2);
  assert.equal(session.strokes.length, 1);
  assert.equal(session.canRedo(), true);

  const redone = session.redo();
  assert.equal(redone.points[0].x, 2);
  assert.equal(session.strokes.length, 2);
  assert.equal(session.canRedo(), false);
});

test("a new stroke clears the redo stack", () => {
  const session = MaskModel.createMaskSession();
  session.addStroke(stroke("brush", 1));
  session.undo();
  assert.equal(session.canRedo(), true);
  session.addStroke(stroke("brush", 2));
  assert.equal(session.canRedo(), false);
});

test("stroke history is capped at MASK_MAX_STEPS, dropping the oldest", () => {
  const session = MaskModel.createMaskSession();
  for (let i = 0; i < MaskModel.MASK_MAX_STEPS + 5; i += 1) session.addStroke(stroke("brush", i));
  assert.equal(session.strokes.length, MaskModel.MASK_MAX_STEPS);
  assert.equal(session.strokes[0].points[0].x, 5);
});

test("clear empties both stacks", () => {
  const session = MaskModel.createMaskSession();
  session.addStroke(stroke("brush", 1));
  session.undo();
  session.clear();
  assert.equal(session.isEmpty(), true);
  assert.equal(session.canRedo(), false);
});

test("invalid strokes are ignored", () => {
  const session = MaskModel.createMaskSession();
  session.addStroke(null);
  session.addStroke({ tool: "brush", radius: 10, points: [] });
  assert.equal(session.isEmpty(), true);
});

test("session can bind to an existing strokes array", () => {
  const strokes = [stroke("brush", 1)];
  const session = MaskModel.createMaskSession(strokes);
  assert.equal(session.strokes, strokes);
  assert.equal(session.canUndo(), true);
  session.undo();
  assert.equal(strokes.length, 0);
});

test("brush size bounds are exposed", () => {
  assert.equal(MaskModel.MASK_BRUSH_MIN, 10);
  assert.equal(MaskModel.MASK_BRUSH_MAX, 300);
  assert.equal(MaskModel.MASK_BRUSH_DEFAULT, 80);
});
