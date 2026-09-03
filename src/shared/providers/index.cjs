"use strict";

const openai = require("./openai.cjs");

// Interface types offered in the connection editor. seedream/gemini adapters land
// in the next v0.6.0 stage; until they are registered below, resolveProvider
// falls back to openai for every id that is not in the registry.
const PROVIDER_IDS = ["openai", "seedream", "gemini"];

const registry = new Map([["openai", openai]]);

function normalizeProvider(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return PROVIDER_IDS.includes(candidate) ? candidate : "openai";
}

function resolveProvider(profile) {
  const id = normalizeProvider(profile?.provider);
  return registry.get(id) || openai;
}

module.exports = { PROVIDER_IDS, normalizeProvider, resolveProvider };
