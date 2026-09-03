"use strict";

const Validation = require("../validation.js");

// Gemini image adapter (models/{model}:generateContent). Nothing here resembles the
// OpenAI images API: auth is an x-goog-api-key header, the body is a contents
// payload, and images come back as inlineData parts.
//
// Two consequences drive the shape of this file:
// - One request yields one image, so the caller loops for n > 1 (see batchLimit).
// - There is no mask channel, so mask edits are rejected upstream.
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_REFERENCE_IMAGES = 14;
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_IMAGE_SIZE = "2K";

function requireValid(validation, message) {
  if (validation.valid) return;
  const error = new Error(message);
  error.details = validation.errors;
  throw error;
}

// Gemini takes one of ten fixed aspect ratios, so the requested pixel size is
// matched to the closest supported ratio rather than being sent verbatim.
function resolveAspectRatio(size) {
  const parsed = Validation.parseSize(size);
  if (parsed.error || parsed.auto || !parsed.width || !parsed.height) return DEFAULT_ASPECT_RATIO;
  const target = parsed.width / parsed.height;
  return ASPECT_RATIOS.reduce((best, ratio) => {
    const [w, h] = ratio.split(":").map(Number);
    const current = Math.abs(Math.log(target / (w / h)));
    return current < best.distance ? { ratio, distance: current } : best;
  }, { ratio: DEFAULT_ASPECT_RATIO, distance: Infinity }).ratio;
}

// imageSize is a quality tier, not a resolution: pick the tier that covers the
// requested pixel count. Values must be uppercase "K" or the API rejects them.
function resolveImageSize(size) {
  const parsed = Validation.parseSize(size);
  if (parsed.error || parsed.auto || !parsed.width || !parsed.height) return DEFAULT_IMAGE_SIZE;
  const pixels = parsed.width * parsed.height;
  if (pixels <= 1280 * 1280) return "1K";
  if (pixels <= 2560 * 2560) return "2K";
  return "4K";
}

function inlineParts(inputFiles) {
  const files = Array.isArray(inputFiles) ? inputFiles : [];
  if (files.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Gemini 单次最多参考 ${MAX_REFERENCE_IMAGES} 张图片`);
  }
  // inlineData carries raw base64 with no data: prefix.
  return files.map((file) => ({
    inlineData: {
      mimeType: String(file?.mime || "image/png"),
      data: Buffer.from(file.buffer).toString("base64"),
    },
  }));
}

const geminiAdapter = {
  id: "gemini",
  label: "Gemini · Google 生成内容接口",
  capabilities: { generation: true, referenceEdit: true, maskEdit: false, stream: false },
  editTransport: "json",
  // generateContent returns a single image per call, so n > 1 is issued serially.
  batchLimit: 1,
  maxReferenceImages: MAX_REFERENCE_IMAGES,

  endpoints(baseUrl, profile) {
    const root = Validation.normalizeBaseUrl(baseUrl);
    const model = String(profile?.model || "").trim();
    // Model names can carry a "models/" prefix users paste from the docs; trim it
    // so the path does not end up doubled.
    const slug = model.replace(/^models\//, "");
    const target = slug ? `/models/${encodeURIComponent(slug)}:generateContent` : "/models:generateContent";
    return { generation: `${root}${target}`, edit: `${root}${target}`, models: `${root}/models` };
  },

  headers(apiKey) {
    return { "x-goog-api-key": apiKey };
  },

  buildGenerationBody(input /* , profile */) {
    requireValid(Validation.validateGeneration(input), "生成参数校验失败");
    return {
      contents: [{ role: "user", parts: [{ text: String(input.prompt) }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: resolveAspectRatio(input.size), imageSize: resolveImageSize(input.size) },
      },
    };
  },

  buildEditMetadata(input) {
    requireValid(Validation.validateEditInput(input), "编辑参数校验失败");
    return {
      contents: [{ role: "user", parts: [{ text: String(input.prompt) }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: resolveAspectRatio(input.size), imageSize: resolveImageSize(input.size) },
      },
    };
  },

  buildEditBody(metadata, inputFiles /* , maskFile, profile */) {
    const textParts = metadata?.contents?.[0]?.parts?.filter((part) => typeof part.text === "string") || [];
    return {
      ...metadata,
      contents: [{ role: "user", parts: [...inlineParts(inputFiles), ...textParts] }],
    };
  },

  parseResponse(body) {
    const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const images = [];
    const texts = [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        // Downstream decoding only needs b64_json; the mime is informational.
        images.push({ b64_json: part.inlineData.data, mime_type: part.inlineData.mimeType || "image/png" });
      }
      if (typeof part?.text === "string" && part.text.trim()) texts.push(part.text.trim());
    }
    // A blocked prompt returns HTTP 200 with no image, which would otherwise look
    // like a generic empty response; surface the real reason instead.
    const finishReason = candidate?.finishReason || "";
    const blocked = finishReason && finishReason !== "STOP" && !images.length ? finishReason : "";
    return {
      images,
      text: texts.join("\n") || null,
      usage: body?.usageMetadata || null,
      blocked,
    };
  },

  // The Google model list is { models: [{ name: "models/..." }] }, not { data: [...] }.
  parseModels(body) {
    const models = Array.isArray(body?.models) ? body.models : [];
    return models.map((item) => String(item?.name || "").replace(/^models\//, "")).filter(Boolean);
  },
};

module.exports = geminiAdapter;
module.exports.ASPECT_RATIOS = ASPECT_RATIOS;
module.exports.resolveAspectRatio = resolveAspectRatio;
module.exports.resolveImageSize = resolveImageSize;
