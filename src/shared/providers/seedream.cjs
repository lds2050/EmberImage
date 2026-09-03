"use strict";

const Validation = require("../validation.js");

// Seedream (Volcano Engine Ark) adapter. The Ark images API is OpenAI-shaped, so
// both generation and reference edits go to POST /images/generations: edits simply
// carry an `image` array of data URLs instead of using multipart uploads.
//
// Differences from the OpenAI payload that matter:
// - `response_format: b64_json` keeps results local (the Ark default is a 24h URL).
// - `watermark` defaults to true server side and is turned off explicitly.
// - `sequential_image_generation` is disabled so one request never returns a group.
// - quality / background / moderation / output_format are not supported and dropped.
// - Streaming is not wired up for this provider (see capabilities.stream).
const MAX_REFERENCE_IMAGES = 14;
const MAX_IMAGES_PER_REQUEST = 4;

function requireValid(validation, message) {
  if (validation.valid) return;
  const error = new Error(message);
  error.details = validation.errors;
  throw error;
}

function dataUrl(file) {
  // Ark rejects uppercase data URL prefixes, so build them lowercase and pick the
  // mime from the asset itself rather than trusting the file extension.
  const mime = String(file?.mime || "image/png").toLowerCase();
  return `data:${mime};base64,${Buffer.from(file.buffer).toString("base64")}`;
}

const seedreamAdapter = {
  id: "seedream",
  label: "Seedream · 火山方舟",
  capabilities: { generation: true, referenceEdit: true, maskEdit: false, stream: false },
  // Edits are JSON with an inline image array, not multipart/form-data.
  editTransport: "json",
  // Ark caps a single call at four images, so larger batches are issued serially.
  batchLimit: MAX_IMAGES_PER_REQUEST,
  maxReferenceImages: MAX_REFERENCE_IMAGES,

  endpoints(baseUrl) {
    const root = Validation.normalizeBaseUrl(baseUrl);
    return {
      generation: `${root}/images/generations`,
      edit: `${root}/images/generations`,
      models: `${root}/models`,
    };
  },

  headers(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },

  buildGenerationBody(input /* , profile */) {
    requireValid(Validation.validateGeneration(input), "生成参数校验失败");
    return {
      model: String(input.model || "").trim(),
      prompt: String(input.prompt),
      size: input.size,
      // Ark caps the batch below the OpenAI range; extra images would 400.
      n: Math.min(Math.max(Number(input.n) || 1, 1), MAX_IMAGES_PER_REQUEST),
      response_format: "b64_json",
      watermark: false,
      sequential_image_generation: "disabled",
    };
  },

  buildEditMetadata(input) {
    requireValid(Validation.validateEditInput(input), "编辑参数校验失败");
    return {
      model: String(input.model || "").trim(),
      prompt: String(input.prompt),
      size: input.size,
      n: Math.min(Math.max(Number(input.n) || 1, 1), MAX_IMAGES_PER_REQUEST),
      response_format: "b64_json",
      watermark: false,
      sequential_image_generation: "disabled",
    };
  },

  buildEditBody(metadata, inputFiles /* , maskFile, profile */) {
    const files = Array.isArray(inputFiles) ? inputFiles : [];
    if (files.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`Seedream 单次最多参考 ${MAX_REFERENCE_IMAGES} 张图片`);
    }
    return { ...metadata, image: files.map(dataUrl) };
  },

  parseResponse(body) {
    const data = Array.isArray(body?.data) ? body.data : [];
    return { images: data, text: null, usage: body?.usage || null };
  },

  parseModels(body) {
    return Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
  },
};

module.exports = seedreamAdapter;
