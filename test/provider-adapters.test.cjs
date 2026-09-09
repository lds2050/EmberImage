"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Providers = require("../src/shared/providers/index.cjs");
const seedream = require("../src/shared/providers/seedream.cjs");
const gemini = require("../src/shared/providers/gemini.cjs");

const GENERATION_INPUT = {
  prompt: "a lantern on a rainy street",
  size: "1536x1024",
  quality: "high",
  n: 2,
  background: "auto",
  outputFormat: "png",
  moderation: "auto",
  stream: false,
  partialImages: 0,
};
const EDIT_INPUT = { ...GENERATION_INPUT, imageCount: 2 };
const FILES = [
  { buffer: Buffer.from("one"), name: "image-1.png", mime: "image/png" },
  { buffer: Buffer.from("two"), name: "image-2.jpg", mime: "image/jpeg" },
];

const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const GOOGLE = "https://generativelanguage.googleapis.com/v1beta";

// ---------------------------------------------------------------- seedream

test("seedream sends generation and edits to the same generations endpoint", () => {
  const endpoints = seedream.endpoints(ARK);
  assert.equal(endpoints.generation, `${ARK}/images/generations`);
  // Ark has no /images/edits route; reference edits ride on generations.
  assert.equal(endpoints.edit, `${ARK}/images/generations`);
  assert.equal(endpoints.models, `${ARK}/models`);
  assert.equal(seedream.editTransport, "json");
});

test("seedream uses bearer auth like OpenAI", () => {
  assert.deepEqual(seedream.headers("sk-ark"), { Authorization: "Bearer sk-ark" });
});

test("seedream generation body carries the Ark-specific defaults", () => {
  const body = seedream.buildGenerationBody({ ...GENERATION_INPUT, model: "doubao-seedream-4-0-250828" });
  assert.equal(body.model, "doubao-seedream-4-0-250828");
  assert.equal(body.size, "1536x1024");
  assert.equal(body.n, 2);
  assert.equal(body.response_format, "b64_json");
  // Ark defaults the watermark on; it has to be switched off explicitly.
  assert.equal(body.watermark, false);
  assert.equal(body.sequential_image_generation, "disabled");
});

test("seedream drops parameters Ark does not accept", () => {
  const body = seedream.buildGenerationBody({ ...GENERATION_INPUT, model: "m" });
  assert.equal(body.quality, undefined);
  assert.equal(body.background, undefined);
  assert.equal(body.moderation, undefined);
  assert.equal(body.output_format, undefined);
  assert.equal(body.stream, undefined);
});

test("seedream clamps the batch size to the per-request cap", () => {
  assert.equal(seedream.buildGenerationBody({ ...GENERATION_INPUT, n: 10, model: "m" }).n, 4);
  assert.equal(seedream.buildGenerationBody({ ...GENERATION_INPUT, n: 1, model: "m" }).n, 1);
  assert.equal(seedream.batchLimit, 4);
});

test("seedream edits inline images as lowercase data URLs", () => {
  const metadata = seedream.buildEditMetadata({ ...EDIT_INPUT, model: "m" });
  const body = seedream.buildEditBody(metadata, FILES);
  assert.equal(body.image.length, 2);
  assert.equal(body.image[0], `data:image/png;base64,${Buffer.from("one").toString("base64")}`);
  assert.equal(body.image[1], `data:image/jpeg;base64,${Buffer.from("two").toString("base64")}`);
  // Metadata survives so the prompt and size are not lost.
  assert.equal(body.prompt, GENERATION_INPUT.prompt);
});

test("seedream rejects more reference images than the API allows", () => {
  const tooMany = Array.from({ length: 15 }, () => FILES[0]);
  assert.throws(() => seedream.buildEditBody({}, tooMany), /最多参考 14 张/);
});

test("seedream exposes no mask channel", () => {
  assert.equal(seedream.capabilities.maskEdit, false);
  assert.equal(seedream.capabilities.referenceEdit, true);
});

test("seedream parses OpenAI-shaped responses and model lists", () => {
  const parsed = seedream.parseResponse({ data: [{ b64_json: "AAAA" }], usage: { total_tokens: 2 } });
  assert.equal(parsed.images.length, 1);
  assert.deepEqual(parsed.usage, { total_tokens: 2 });
  assert.deepEqual(seedream.parseModels({ data: [{ id: "doubao-seedream-4-0-250828" }] }), ["doubao-seedream-4-0-250828"]);
});

// ------------------------------------------------------------------ gemini

test("gemini targets the generateContent action for the configured model", () => {
  const endpoints = gemini.endpoints(GOOGLE, { model: "gemini-3-pro-image-preview" });
  assert.equal(endpoints.generation, `${GOOGLE}/models/gemini-3-pro-image-preview:generateContent`);
  assert.equal(endpoints.edit, endpoints.generation);
  assert.equal(endpoints.models, `${GOOGLE}/models`);
});

test("gemini strips a models/ prefix instead of doubling it", () => {
  const endpoints = gemini.endpoints(GOOGLE, { model: "models/gemini-3-pro-image-preview" });
  assert.equal(endpoints.generation, `${GOOGLE}/models/gemini-3-pro-image-preview:generateContent`);
});

test("gemini authenticates with x-goog-api-key, not bearer", () => {
  assert.deepEqual(gemini.headers("ya29.x"), { "x-goog-api-key": "ya29.x" });
});

test("gemini generation body requests text and image modalities", () => {
  const body = gemini.buildGenerationBody(GENERATION_INPUT);
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "3:2");
  // The tier must be uppercase K or the API rejects it.
  assert.equal(body.generationConfig.imageConfig.imageSize, "1K");
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: GENERATION_INPUT.prompt }] }]);
});

test("gemini maps sizes to the closest supported aspect ratio", () => {
  assert.equal(gemini.resolveAspectRatio("1024x1024"), "1:1");
  assert.equal(gemini.resolveAspectRatio("1536x1024"), "3:2");
  assert.equal(gemini.resolveAspectRatio("1024x1536"), "2:3");
  assert.equal(gemini.resolveAspectRatio("864x1536"), "9:16");
  assert.equal(gemini.resolveAspectRatio("1536x864"), "16:9");
  assert.equal(gemini.resolveAspectRatio("auto"), "1:1");
  assert.equal(gemini.resolveAspectRatio("bogus"), "1:1");
});

test("gemini maps pixel counts onto 1K/2K/4K tiers", () => {
  assert.equal(gemini.resolveImageSize("1024x1024"), "1K");
  assert.equal(gemini.resolveImageSize("2048x2048"), "2K");
  assert.equal(gemini.resolveImageSize("2880x2880"), "4K");
  assert.equal(gemini.resolveImageSize("auto"), "2K");
});

test("gemini edits inline images before the prompt with no data prefix", () => {
  const metadata = gemini.buildEditMetadata({ ...EDIT_INPUT, model: "m" });
  const body = gemini.buildEditBody(metadata, FILES);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], {
    inlineData: { mimeType: "image/png", data: Buffer.from("one").toString("base64") },
  });
  assert.equal(parts[2].text, GENERATION_INPUT.prompt);
});

test("gemini rejects more reference images than the API allows", () => {
  const tooMany = Array.from({ length: 15 }, () => FILES[0]);
  assert.throws(() => gemini.buildEditBody({}, tooMany), /最多参考 14 张/);
});

test("gemini yields one image per call so the caller loops for batches", () => {
  assert.equal(gemini.batchLimit, 1);
  assert.equal(gemini.capabilities.maskEdit, false);
});

test("gemini parseResponse lifts inlineData into b64_json items", () => {
  const parsed = gemini.parseResponse({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 },
  });
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].b64_json, "AAAA");
  assert.equal(parsed.text, "here you go");
  assert.deepEqual(parsed.usage, { promptTokenCount: 5, candidatesTokenCount: 9 });
  assert.equal(parsed.blocked, "");
});

test("gemini reports a blocked prompt instead of a generic empty response", () => {
  const parsed = gemini.parseResponse({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "sorry" }] } }] });
  assert.equal(parsed.images.length, 0);
  assert.equal(parsed.blocked, "SAFETY");
});

test("gemini tolerates responses with no candidates", () => {
  const parsed = gemini.parseResponse({});
  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.text, null);
  assert.equal(parsed.blocked, "");
});

test("gemini model list drops the models/ prefix", () => {
  assert.deepEqual(gemini.parseModels({ models: [{ name: "models/gemini-3-pro-image-preview" }] }), ["gemini-3-pro-image-preview"]);
  assert.deepEqual(gemini.parseModels({ data: [{ id: "nope" }] }), []);
});

// ------------------------------------------------------------- registry meta

test("provider metadata covers every registered id with defaults and hints", () => {
  const meta = Providers.providerMeta();
  assert.deepEqual(meta.map((item) => item.id), ["openai", "seedream", "gemini"]);
  for (const item of meta) {
    assert.ok(item.label && item.summary, `${item.id} needs a label and summary`);
    assert.match(item.defaultBaseUrl, /^https:\/\//);
    assert.ok(item.defaultModel, `${item.id} needs a default model`);
    assert.ok(item.hint, `${item.id} needs a hint`);
    assert.equal(typeof item.capabilities.maskEdit, "boolean");
  }
  assert.equal(meta.find((item) => item.id === "seedream").defaultBaseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(meta.find((item) => item.id === "gemini").defaultModel, "gemini-3-pro-image-preview");
});

test("capabilitiesOf reflects the active provider", () => {
  assert.equal(Providers.capabilitiesOf({ provider: "openai" }).maskEdit, true);
  assert.equal(Providers.capabilitiesOf({ provider: "gemini" }).maskEdit, false);
  assert.equal(Providers.capabilitiesOf({}).maskEdit, true);
});

test("gemini adapter declares native session support; others do not", () => {
  assert.equal(gemini.nativeSession, true);
  assert.notEqual(Providers.resolveProvider({ provider: "openai" }).nativeSession, true);
  assert.notEqual(Providers.resolveProvider({ provider: "seedream" }).nativeSession, true);
});

test("gemini buildSessionBody appends the new user turn to the replayed history", () => {
  const history = [
    { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "把背景换成森林" }] },
    { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "BBBB" } }, { thoughtSignature: "sig-1" }] },
  ];
  const body = gemini.buildSessionBody({ history, userParts: [{ text: "再亮一点" }], size: "1024x1024" });
  assert.equal(body.contents.length, 3);
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[1].role, "model");
  assert.equal(body.contents[1].parts[1].thoughtSignature, "sig-1", "thoughtSignature echoed verbatim");
  assert.deepEqual(body.contents[2], { role: "user", parts: [{ text: "再亮一点" }] });
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.ok(body.generationConfig.imageConfig.aspectRatio);
});

test("gemini extractNativeReply stores the model content verbatim", () => {
  const body = {
    candidates: [{
      content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "CCCC" } }, { thoughtSignature: "sig-2" }] },
      finishReason: "STOP",
    }],
  };
  const reply = gemini.extractNativeReply(body);
  assert.equal(reply.role, "model");
  assert.equal(reply.parts.length, 2);
  assert.equal(reply.parts[1].thoughtSignature, "sig-2");
  // Mutating the extracted copy must not touch the original payload.
  reply.parts[0].inlineData.data = "XXXX";
  assert.equal(body.candidates[0].content.parts[0].inlineData.data, "CCCC");
});

test("gemini extractNativeReply returns null for blocked or empty candidates", () => {
  assert.equal(gemini.extractNativeReply({ candidates: [{ finishReason: "SAFETY" }] }), null);
  assert.equal(gemini.extractNativeReply({ candidates: [{ content: { role: "model", parts: [] } }] }), null);
  assert.equal(gemini.extractNativeReply({}), null);
  assert.equal(gemini.extractNativeReply(null), null);
});
