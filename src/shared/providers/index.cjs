"use strict";

const openai = require("./openai.cjs");
const seedream = require("./seedream.cjs");
const gemini = require("./gemini.cjs");

// Interface types offered in the connection editor. Unknown or missing ids fall back
// to the OpenAI-compatible adapter so older configs keep working untouched.
const PROVIDER_IDS = ["openai", "seedream", "gemini"];

const registry = new Map([
  ["openai", openai],
  ["seedream", seedream],
  ["gemini", gemini],
]);

function normalizeProvider(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return PROVIDER_IDS.includes(candidate) ? candidate : "openai";
}

function resolveProvider(profile) {
  const id = normalizeProvider(profile?.provider);
  return registry.get(id) || openai;
}

function capabilitiesOf(profile) {
  return resolveProvider(profile).capabilities;
}

// Drives the connection editor: labels, default endpoints and per-provider hints.
// Kept next to the adapters so the UI never carries a second copy of these values.
const PROVIDER_META = [
  {
    id: "openai",
    label: "OpenAI 兼容",
    summary: "gpt-image 系列与兼容中转",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
    hint: "OpenAI 官方填写 https://api.openai.com/v1；其他服务填写其兼容地址。支持文字生图、参考图编辑与 Mask 局部编辑。",
  },
  {
    id: "seedream",
    label: "Seedream",
    summary: "火山方舟 · 参考图编辑",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seedream-4-0-250828",
    hint: "火山方舟控制台获取 API Key。文字生图与参考图编辑可用，单次最多 14 张参考图；不支持 Mask 局部编辑，输出无水印。",
  },
  {
    id: "gemini",
    label: "Gemini",
    summary: "Google 生成内容接口",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3-pro-image-preview",
    hint: "文字生图与参考图编辑可用，一次请求出一张图，多张会串行生成；不支持 Mask 局部编辑。尺寸按最接近的比例与 1K/2K/4K 档位转换。",
  },
];

function providerMeta() {
  return PROVIDER_META.map((meta) => ({
    ...meta,
    capabilities: { ...(registry.get(meta.id) || openai).capabilities },
  }));
}

module.exports = { PROVIDER_IDS, PROVIDER_META, capabilitiesOf, normalizeProvider, providerMeta, resolveProvider };
