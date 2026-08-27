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

  const QUALITY_VALUES = new Set(["auto", "low", "medium", "high"]);
  const FORMAT_VALUES = new Set(["png", "jpeg", "webp"]);
  const BACKGROUND_VALUES = new Set(["auto", "opaque", "transparent"]);
  const MODERATION_VALUES = new Set(["auto", "low"]);
  const MAX_PROMPT_LENGTH = 32000;
  const MAX_PIXELS = 3840 * 2160;
  const EXPERIMENTAL_PIXELS = 2560 * 1440;
  const MAX_EDGE = 3840;

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
    path = path.replace(/\/images\/generations$/i, "");
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
    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
      return { error: "尺寸超过 GPT Image 2 当前最大分辨率范围" };
    }
    return {
      width,
      height,
      auto: false,
      experimental: width * height > EXPERIMENTAL_PIXELS,
    };
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

  function validateGeneration(input) {
    const errors = {};
    const warnings = [];
    const prompt = String(input.prompt || "");
    const sizeResult = parseSize(input.size);

    if (!prompt.trim()) errors.prompt = "请输入画面描述";
    if (prompt.length > MAX_PROMPT_LENGTH) {
      errors.prompt = `提示词不能超过 ${MAX_PROMPT_LENGTH.toLocaleString()} 个字符`;
    }
    if (!QUALITY_VALUES.has(input.quality)) errors.quality = "请选择有效质量";
    if (!FORMAT_VALUES.has(input.outputFormat)) errors.outputFormat = "请选择有效格式";
    if (!BACKGROUND_VALUES.has(input.background)) errors.background = "请选择有效背景";
    if (!MODERATION_VALUES.has(input.moderation)) errors.moderation = "请选择有效审核级别";

    const count = Number(input.n);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      errors.n = "生成数量必须是 1 到 10 的整数";
    }

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

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      warnings,
      size: sizeResult,
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

  return {
    BACKGROUND_VALUES,
    FORMAT_VALUES,
    MAX_PROMPT_LENGTH,
    MODERATION_VALUES,
    QUALITY_VALUES,
    buildGenerationPayload,
    generationEndpoint,
    modelsEndpoint,
    normalizeBaseUrl,
    parseSize,
    validateConnection,
    validateGeneration,
  };
});
