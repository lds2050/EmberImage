"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Validation = require("../src/shared/validation.js");

const BASE = {
  model: "gpt-image-2",
  prompt: "把杯子改成玻璃杯",
  size: "1024x1024",
  quality: "auto",
  n: 1,
  background: "auto",
  outputFormat: "png",
  moderation: "auto",
  stream: false,
};

test("editEndpoint normalizes and appends /images/edits", () => {
  assert.equal(Validation.editEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/images/edits");
  assert.equal(Validation.editEndpoint("https://proxy.example.com/v1/"), "https://proxy.example.com/v1/images/edits");
});

test("normalizeBaseUrl strips a trailing /images/edits suffix", () => {
  assert.equal(Validation.normalizeBaseUrl("https://proxy.example.com/v1/images/edits"), "https://proxy.example.com/v1");
  assert.equal(Validation.normalizeBaseUrl("https://proxy.example.com/v1/images/generations"), "https://proxy.example.com/v1");
});

test("validateEditInput requires prompt and 1-16 images", () => {
  assert.equal(Validation.validateEditInput({ ...BASE, imageCount: 1 }).valid, true);

  const noPrompt = Validation.validateEditInput({ ...BASE, prompt: "   ", imageCount: 1 });
  assert.ok(noPrompt.errors.prompt);

  const tooLong = Validation.validateEditInput({ ...BASE, prompt: "x".repeat(32001), imageCount: 1 });
  assert.ok(tooLong.errors.prompt);

  assert.ok(Validation.validateEditInput({ ...BASE, imageCount: 0 }).errors.imageCount);
  assert.ok(Validation.validateEditInput({ ...BASE, imageCount: 17 }).errors.imageCount);
  assert.equal(Validation.validateEditInput({ ...BASE, imageCount: 16 }).valid, true);
});

test("validateEditInput rejects transparent background with JPEG", () => {
  const result = Validation.validateEditInput({ ...BASE, background: "transparent", outputFormat: "jpeg", imageCount: 1 });
  assert.ok(result.errors.outputFormat);
});

test("buildEditMetadata omits input_fidelity and emits scalar fields", () => {
  const metadata = Validation.buildEditMetadata({ ...BASE, imageCount: 2 });
  assert.equal(metadata.model, "gpt-image-2");
  assert.equal(metadata.prompt, BASE.prompt);
  assert.equal(metadata.size, "1024x1024");
  assert.equal(metadata.output_format, "png");
  assert.equal(metadata.stream, false);
  assert.ok(!("input_fidelity" in metadata));
  assert.ok(!("output_compression" in metadata));
  assert.ok(!("partial_images" in metadata));
});

test("buildEditMetadata includes compression for webp and partial_images when streaming", () => {
  const webp = Validation.buildEditMetadata({ ...BASE, outputFormat: "webp", outputCompression: 80, imageCount: 1 });
  assert.equal(webp.output_compression, 80);
  assert.ok(!("partial_images" in webp));

  const streamed = Validation.buildEditMetadata({ ...BASE, stream: true, partialImages: 2, imageCount: 1 });
  assert.equal(streamed.stream, true);
  assert.equal(streamed.partial_images, 2);
  assert.ok(!("output_compression" in streamed));
});

test("buildEditMetadata throws with field details when invalid", () => {
  assert.throws(() => Validation.buildEditMetadata({ ...BASE, imageCount: 0 }), (error) => {
    assert.ok(error.details.imageCount);
    return true;
  });
});
