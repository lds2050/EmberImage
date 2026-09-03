"use strict";

const Validation = require("../validation.js");
const { buildEditFormData } = require("../edit-form.js");

// OpenAI images API adapter. Wraps the exact generation/edit payload logic that
// shipped through v0.5.4 so existing connections behave byte-for-byte the same.
// Edits go out as multipart/form-data: buildEditBody returns a FormData and the
// fetch caller must NOT set Content-Type manually (the runtime adds the boundary).
const openaiAdapter = {
  id: "openai",
  capabilities: { generation: true, referenceEdit: true, maskEdit: true },

  endpoints(baseUrl) {
    return {
      generation: Validation.generationEndpoint(baseUrl),
      edit: Validation.editEndpoint(baseUrl),
      models: Validation.modelsEndpoint(baseUrl),
    };
  },

  headers(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },

  buildGenerationBody(input /* , profile */) {
    return Validation.buildGenerationPayload(input);
  },

  buildEditMetadata(input) {
    return Validation.buildEditMetadata(input);
  },

  buildEditBody(metadata, inputFiles, maskFile /* , profile */) {
    return buildEditFormData(metadata, inputFiles, maskFile);
  },

  // Normalizes an OpenAI-shaped response into { images, text, usage }.
  // `images` keeps the raw data items (b64_json / url) for the pipeline to decode.
  parseResponse(body) {
    const data = Array.isArray(body?.data) ? body.data : [];
    return { images: data, text: null, usage: body?.usage || null };
  },
};

module.exports = openaiAdapter;
