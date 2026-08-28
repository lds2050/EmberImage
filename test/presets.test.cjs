"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const catalog = require("../src/shared/presets.js");
const Validation = require("../src/shared/validation.js");

test("ships six valid, uniquely identified presets", () => {
  assert.equal(catalog.presets.length, 6);
  assert.equal(new Set(catalog.presets.map((preset) => preset.id)).size, catalog.presets.length);
  assert.deepEqual(catalog.categories.map((category) => category.id), ["all", "spring", "rainy", "waterside", "winter"]);

  for (const preset of catalog.presets) {
    assert.ok(preset.title);
    assert.ok(preset.prompt.length > 100);
    assert.ok(Array.isArray(preset.tags) && preset.tags.length === 3);
    assert.ok(catalog.categories.some((category) => category.id === preset.category));
    assert.equal(Validation.validateGeneration({ prompt: preset.prompt, ...preset.parameters, partialImages: 0 }).valid, true);
  }
});

test("ships lightweight local previews without sensitive metadata", () => {
  let totalBytes = 0;
  for (const preset of catalog.presets) {
    const imagePath = path.resolve(__dirname, "../src/shared", preset.imagePath);
    const stat = fs.statSync(imagePath);
    assert.equal(path.extname(imagePath), ".webp");
    assert.ok(stat.size > 0);
    totalBytes += stat.size;
  }
  assert.ok(totalBytes < 1024 * 1024, `preset previews are ${totalBytes} bytes`);

  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /api[_ -]?key|authorization|request[_ -]?id|filePath|baseUrl/i);
});
