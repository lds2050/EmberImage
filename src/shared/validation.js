(function exposeValidation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ImageStudioValidation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createValidation() {
  "use strict";

  const QUALITY_VALUES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
  const FORMAT_VALUES = new Set(["png", "jpeg", "webp"]);
  const BACKGROUND_VALUES = new Set(["auto", "opaque", "transparent"]);
  const MODERATION_VALUES = new Set(["auto", "low"]);
  const MAX_PROMPT_LENGTH = 32000;
  const MAX_EDIT_IMAGES = 16;
  const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024;
  const MIN_PIXELS = 655360;
  const MAX_PIXELS = 3840 * 2160;
  const EXPERIMENTAL_PIXELS = 2560 * 1440;
  const MAX_EDGE = 3840;
  const SIZE_PRESETS = Object.freeze({
    "1:1": Object.freeze({ "1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880" }),
    "3:2": Object.freeze({ "1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2352" }),
    "2:3": Object.freeze({ "1k": "1024x1536", "2k": "1360x2048", "4k": "2352x3520" }),
    "16:9": Object.freeze({ "1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160" }),
    "9:16": Object.freeze({ "1k": "864x1536", "2k": "1152x2048", "4k": "2160x3840" }),
    "4:3": Object.freeze({ "1k": "1360x1024", "2k": "2048x1536", "4k": "3264x2448" }),
    "3:4": Object.freeze({ "1k": "1024x1360", "2k": "1536x2048", "4k": "2448x3264" }),
    "21:9": Object.freeze({ "1k": "1536x656", "2k": "2048x880", "4k": "3808x1632" }),
  });

  function normalizeBaseUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const url = new URL(raw);
    if (!new Set(["https:", "http:"]).has(url.protocol)) {
      throw new Error("API 地址仅支持 HTTP 或 HTTPS");
    }
    if (url.username || url.password) {
      throw new Error("API 地址中不能包含用户名或密码");
    }

    let path = url.pathname.replace(/\/+$/, "");
    path = path.replace(/\/images\/(?:generations|edits)$/i, "");
    if (url.hostname === "api.openai.com" && (!path || path === "/")) {
      path = "/v1";
    }
    url.pathname = path || "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  function generationEndpoint(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/images/generations`;
  }

  function editEndpoint(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/images/edits`;
  }

  function modelsEndpoint(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/models`;
  }

  function parseSize(size) {
    if (size === "auto") {
      return { auto: true, experimental: false };
    }
    const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
    if (!match) {
      return { error: "尺寸格式应为 宽x高，例如 1536x1024" };
    }

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) {
      return { error: "宽度和高度必须大于 0" };
    }
    if (width % 16 !== 0 || height % 16 !== 0) {
      const nearestWidth = Math.max(16, Math.round(width / 16) * 16);
      const nearestHeight = Math.max(16, Math.round(height / 16) * 16);
      return {
        error: `宽度和高度都必须是 16 的倍数，建议 ${nearestWidth}x${nearestHeight}`,
      };
    }
    const ratio = width / height;
    if (ratio < 1 / 3 || ratio > 3) {
      return { error: "宽高比必须在 1:3 到 3:1 之间" };
    }
    if (width * height < MIN_PIXELS) {
      return { error: "总像素不能低于 655,360" };
    }
    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
      return { error: "尺寸超过 GPT Image 系列当前最大分辨率范围" };
    }
    return {
      width,
      height,
      auto: false,
      experimental: width * height > EXPERIMENTAL_PIXELS,
    };
  }

  function resolvePresetSize(ratio, resolution) {
    return SIZE_PRESETS[ratio]?.[resolution] || "";
  }

  function findSizePreset(size) {
    for (const [ratio, resolutions] of Object.entries(SIZE_PRESETS)) {
      for (const [resolution, presetSize] of Object.entries(resolutions)) {
        if (presetSize === size) return { ratio, resolution };
      }
    }
    return null;
  }

  function validateConnection(connection, options = {}) {
    const errors = {};
    try {
      normalizeBaseUrl(connection.baseUrl);
    } catch (error) {
      errors.baseUrl = error.message;
    }
    if (!String(connection.baseUrl || "").trim()) {
      errors.baseUrl = "请输入 API Base URL";
    }
    if (!String(connection.model || "").trim()) {
      errors.model = "请输入模型名称";
    }
    if (options.requireKey && !String(connection.apiKey || "").trim()) {
      errors.apiKey = "请输入 API Key";
    }
    return { valid: Object.keys(errors).length === 0, errors };
  }

  function validateOutputParams(input, errors, warnings) {
    if (!QUALITY_VALUES.has(input.quality)) errors.quality = "请选择有效质量";
    if (!FORMAT_VALUES.has(input.outputFormat)) errors.outputFormat = "请选择有效格式";
    if (!BACKGROUND_VALUES.has(input.background)) errors.background = "请选择有效背景";
    if (!MODERATION_VALUES.has(input.moderation)) errors.moderation = "请选择有效审核级别";

    const count = Number(input.n);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      errors.n = "生成数量必须是 1 到 10 的整数";
    }

    const sizeResult = parseSize(input.size);
    if (sizeResult.error) {
      errors.size = sizeResult.error;
    } else if (sizeResult.experimental) {
      warnings.push("当前尺寸高于 2560x1440 等效像素范围，属于实验尺寸，可能失败或表现不稳定");
    }

    if (input.background === "transparent" && input.outputFormat === "jpeg") {
      errors.outputFormat = "透明背景不支持 JPEG，请选择 PNG 或 WebP";
    }

    if (["jpeg", "webp"].includes(input.outputFormat)) {
      const compression = Number(input.outputCompression);
      if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
        errors.outputCompression = "压缩率必须是 0 到 100 的整数";
      }
    }

    if (input.stream) {
      const partialImages = Number(input.partialImages);
      if (!Number.isInteger(partialImages) || partialImages < 0 || partialImages > 3) {
        errors.partialImages = "部分图数量必须是 0 到 3 的整数";
      }
    }

    return sizeResult;
  }

  function validatePrompt(prompt, errors, emptyMessage) {
    const value = String(prompt || "");
    if (!value.trim()) errors.prompt = emptyMessage;
    if (value.length > MAX_PROMPT_LENGTH) {
      errors.prompt = `提示词不能超过 ${MAX_PROMPT_LENGTH.toLocaleString()} 个字符`;
    }
  }

  function validateGeneration(input) {
    const errors = {};
    const warnings = [];
    validatePrompt(input.prompt, errors, "请输入画面描述");
    const size = validateOutputParams(input, errors, warnings);
    return {
      valid: Object.keys(errors).length === 0,
      errors,
      warnings,
      size,
    };
  }

  function validateEditInput(input) {
    const errors = {};
    const warnings = [];
    validatePrompt(input.prompt, errors, "请输入编辑要求");

    const imageCount = Number(input.imageCount);
    if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > MAX_EDIT_IMAGES) {
      errors.imageCount = `每次最多添加 ${MAX_EDIT_IMAGES} 张图片，且至少需要 1 张`;
    }

    const size = validateOutputParams(input, errors, warnings);
    return {
      valid: Object.keys(errors).length === 0,
      errors,
      warnings,
      size,
    };
  }

  function buildGenerationPayload(input) {
    const validation = validateGeneration(input);
    if (!validation.valid) {
      const error = new Error("生成参数校验失败");
      error.details = validation.errors;
      throw error;
    }

    const payload = {
      model: String(input.model || "gpt-image-2").trim(),
      prompt: String(input.prompt),
      size: input.size,
      quality: input.quality,
      n: Number(input.n),
      background: input.background,
      output_format: input.outputFormat,
      moderation: input.moderation,
      stream: Boolean(input.stream),
    };

    if (["jpeg", "webp"].includes(input.outputFormat)) {
      payload.output_compression = Number(input.outputCompression);
    }
    if (input.stream) {
      payload.partial_images = Number(input.partialImages);
    }
    return payload;
  }

  function buildEditMetadata(input) {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      const error = new Error("编辑参数校验失败");
      error.details = validation.errors;
      throw error;
    }

    // gpt-image-2 固定高保真处理输入图，input_fidelity 从不发送。
    const metadata = {
      model: String(input.model || "gpt-image-2").trim(),
      prompt: String(input.prompt),
      size: input.size,
      quality: input.quality,
      n: Number(input.n),
      background: input.background,
      output_format: input.outputFormat,
      moderation: input.moderation,
      stream: Boolean(input.stream),
    };
    if (["jpeg", "webp"].includes(input.outputFormat)) {
      metadata.output_compression = Number(input.outputCompression);
    }
    if (input.stream) {
      metadata.partial_images = Number(input.partialImages);
    }
    return metadata;
  }

  return {
    BACKGROUND_VALUES,
    FORMAT_VALUES,
    MAX_EDIT_IMAGES,
    MAX_EDIT_IMAGE_BYTES,
    MAX_PROMPT_LENGTH,
    MIN_PIXELS,
    MODERATION_VALUES,
    QUALITY_VALUES,
    SIZE_PRESETS,
    buildEditMetadata,
    buildGenerationPayload,
    editEndpoint,
    findSizePreset,
    generationEndpoint,
    modelsEndpoint,
    normalizeBaseUrl,
    parseSize,
    resolvePresetSize,
    validateConnection,
    validateEditInput,
    validateGeneration,
  };
});
