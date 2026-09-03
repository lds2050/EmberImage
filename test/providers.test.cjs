"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Providers = require("../src/shared/providers/index.cjs");
const openaiAdapter = require("../src/shared/providers/openai.cjs");
const Validation = require("../src/shared/validation.js");
const { DEFAULT_PROFILE } = require("../src/main/storage.cjs");

const GENERATION_INPUT = {
  prompt: "a lantern on a rainy street",
  size: "1024x1024",
  quality: "high",
  n: 2,
  background: "auto",
  outputFormat: "png",
  moderation: "auto",
  stream: false,
  partialImages: 0,
};

const EDIT_METADATA_INPUT = {
  ...GENERATION_INPUT,
  imageCount: 2,
};

const EDIT_FILES = [
  { buffer: Buffer.from("one"), name: "image-1.png", mime: "image/png" },
  { buffer: Buffer.from("two"), name: "image-2.jpg", mime: "image/jpeg" },
];
const MASK_FILE = { buffer: Buffer.from("mask"), name: "mask.png", mime: "image/png" };

test("provider registry exposes the three interface types", () => {
  assert.deepEqual(Providers.PROVIDER_IDS, ["openai", "seedream", "gemini"]);
});

test("normalizeProvider keeps whitelisted ids and falls back to openai", () => {
  assert.equal(Providers.normalizeProvider(undefined), "openai");
  assert.equal(Providers.normalizeProvider(null), "openai");
  assert.equal(Providers.normalizeProvider(""), "openai");
  assert.equal(Providers.normalizeProvider("openai"), "openai");
  assert.equal(Providers.normalizeProvider("OpenAI"), "openai");
  assert.equal(Providers.normalizeProvider(" seedream "), "seedream");
  assert.equal(Providers.normalizeProvider("foo"), "openai");
});

test("resolveProvider defaults to openai for legacy profiles without the field", () => {
  assert.equal(Providers.resolveProvider({}).id, "openai");
  assert.equal(Providers.resolveProvider({ provider: "openai" }).id, "openai");
  assert.equal(Providers.resolveProvider(null).id, "openai");
});

test("resolveProvider returns the registered adapter for every known id", () => {
  assert.equal(Providers.resolveProvider({ provider: "openai" }).id, "openai");
  assert.equal(Providers.resolveProvider({ provider: "seedream" }).id, "seedream");
  assert.equal(Providers.resolveProvider({ provider: "gemini" }).id, "gemini");
});

test("resolveProvider still falls back to openai for unknown ids", () => {
  // Guards configs whose provider value predates (or falls outside) the whitelist.
  assert.equal(Providers.resolveProvider({ provider: "weird-value" }).id, "openai");
});

test("default profile ships with the openai provider", () => {
  assert.equal(DEFAULT_PROFILE.provider, "openai");
});

test("openai adapter declares full capabilities", () => {
  assert.equal(openaiAdapter.capabilities.generation, true);
  assert.equal(openaiAdapter.capabilities.referenceEdit, true);
  assert.equal(openaiAdapter.capabilities.maskEdit, true);
});

test("openai endpoints match the shared endpoint helpers", () => {
  const endpoints = openaiAdapter.endpoints("https://relay.example.com/v1");
  assert.equal(endpoints.generation, Validation.generationEndpoint("https://relay.example.com/v1"));
  assert.equal(endpoints.edit, Validation.editEndpoint("https://relay.example.com/v1"));
  assert.equal(endpoints.models, Validation.modelsEndpoint("https://relay.example.com/v1"));
});

test("openai headers use bearer auth", () => {
  assert.deepEqual(openaiAdapter.headers("sk-test"), { Authorization: "Bearer sk-test" });
});

test("openai generation body equals the legacy payload", () => {
  const adapted = openaiAdapter.buildGenerationBody({ ...GENERATION_INPUT, model: "gpt-image-2" }, {});
  const legacy = Validation.buildGenerationPayload({ ...GENERATION_INPUT, model: "gpt-image-2" });
  assert.deepEqual(adapted, legacy);
});

test("openai generation body rejects invalid input with field details", () => {
  assert.throws(
    () => openaiAdapter.buildGenerationBody({ ...GENERATION_INPUT, prompt: "  " }, {}),
    (error) => error.details && typeof error.details.prompt === "string",
  );
});

test("openai edit body builds multipart form data with inputs and mask", () => {
  const metadata = openaiAdapter.buildEditMetadata({ ...EDIT_METADATA_INPUT, model: "gpt-image-2" });
  const form = openaiAdapter.buildEditBody(metadata, EDIT_FILES, MASK_FILE);
  assert.ok(typeof form.append === "function");
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("prompt"), EDIT_METADATA_INPUT.prompt);
  assert.equal(form.get("size"), "1024x1024");
  assert.equal(form.get("quality"), "high");
  assert.equal(form.get("n"), "2");
  assert.equal(form.get("background"), "auto");
  assert.equal(form.get("output_format"), "png");
  assert.equal(form.get("moderation"), "auto");
  assert.equal(form.get("stream"), "false");
  assert.equal(form.getAll("image[]").length, 2);
  assert.ok(form.get("mask"));
  assert.equal(form.get("partial_images"), null);
  assert.equal(form.get("output_compression"), null);
});

test("openai edit body appends conditional fields only when applicable", () => {
  const metadata = openaiAdapter.buildEditMetadata({
    ...EDIT_METADATA_INPUT,
    model: "gpt-image-2",
    outputFormat: "jpeg",
    outputCompression: 85,
    stream: true,
    partialImages: 2,
  });
  const form = openaiAdapter.buildEditBody(metadata, EDIT_FILES, null);
  assert.equal(form.get("output_format"), "jpeg");
  assert.equal(form.get("output_compression"), "85");
  assert.equal(form.get("partial_images"), "2");
  assert.equal(form.get("mask"), null);
});

test("openai parseResponse normalizes images and usage", () => {
  const parsed = openaiAdapter.parseResponse({ data: [{ b64_json: "AAAA" }, { url: "https://x/y.png" }], usage: { total: 3 } });
  assert.equal(parsed.images.length, 2);
  assert.deepEqual(parsed.images[0], { b64_json: "AAAA" });
  assert.deepEqual(parsed.usage, { total: 3 });
  assert.equal(parsed.text, null);
});

test("openai parseResponse tolerates missing data", () => {
  assert.deepEqual(openaiAdapter.parseResponse({}), { images: [], text: null, usage: null });
  assert.deepEqual(openaiAdapter.parseResponse(null), { images: [], text: null, usage: null });
});
