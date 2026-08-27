"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../src/shared/validation.js");

function validInput(overrides = {}) {
  return {
    prompt: "一只戴橙色围巾的水獭",
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "auto",
    n: 1,
    background: "auto",
    outputFormat: "png",
    outputCompression: 90,
    moderation: "auto",
    stream: false,
    partialImages: 0,
    ...overrides,
  };
}

test("normalizes official and full generation URLs", () => {
  assert.equal(V.normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  assert.equal(
    V.normalizeBaseUrl("https://example.com/v1/images/generations/"),
    "https://example.com/v1",
  );
  assert.equal(V.generationEndpoint("https://example.com/v1/"), "https://example.com/v1/images/generations");
});

test("validates flexible GPT Image 2 dimensions", () => {
  assert.deepEqual(V.parseSize("1536x864"), {
    width: 1536,
    height: 864,
    auto: false,
    experimental: false,
  });
  assert.match(V.parseSize("1025x1024").error, /16 的倍数/);
  assert.match(V.parseSize("3840x1280").error || "", /^$/);
  assert.match(V.parseSize("3840x1024").error, /宽高比/);
  assert.match(V.parseSize("3840x2160").experimental ? "experimental" : "", /experimental/);
  assert.match(V.parseSize("3840x3840").error, /最大分辨率/);
});

test("rejects transparent JPEG output", () => {
  const result = V.validateGeneration(validInput({ background: "transparent", outputFormat: "jpeg" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.outputFormat, /透明背景/);
});

test("builds a minimal PNG payload without irrelevant fields", () => {
  const payload = V.buildGenerationPayload(validInput());
  assert.equal(payload.model, "gpt-image-2");
  assert.equal(payload.output_format, "png");
  assert.equal("output_compression" in payload, false);
  assert.equal("partial_images" in payload, false);
  assert.equal("response_format" in payload, false);
  assert.equal("style" in payload, false);
});

test("includes format-specific and streaming fields only when active", () => {
  const payload = V.buildGenerationPayload(validInput({
    outputFormat: "webp",
    outputCompression: 82,
    stream: true,
    partialImages: 2,
  }));
  assert.equal(payload.output_compression, 82);
  assert.equal(payload.partial_images, 2);
});

test("validates quantity and prompt limits", () => {
  assert.equal(V.validateGeneration(validInput({ n: 11 })).valid, false);
  assert.equal(V.validateGeneration(validInput({ prompt: "" })).valid, false);
  assert.equal(V.validateGeneration(validInput({ prompt: "x".repeat(32001) })).valid, false);
});
