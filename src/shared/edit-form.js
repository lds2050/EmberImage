"use strict";

// Builds the multipart/form-data body for POST /images/edits.
// Relies on the Node 24 / Electron-main globals FormData and File. The fetch caller
// must NOT set Content-Type manually so the runtime supplies the boundary.
// gpt-image-2 always processes inputs at high fidelity, so input_fidelity is never appended.
function buildEditFormData(metadata, inputFiles, maskFile) {
  const form = new FormData();
  form.append("model", metadata.model);
  form.append("prompt", metadata.prompt);
  for (const file of inputFiles) {
    form.append("image[]", new File([file.buffer], file.name, { type: file.mime }));
  }
  if (maskFile) {
    form.append("mask", new File([maskFile.buffer], maskFile.name, { type: maskFile.mime }));
  }
  form.append("size", metadata.size);
  form.append("quality", metadata.quality);
  form.append("n", String(metadata.n));
  form.append("background", metadata.background);
  form.append("output_format", metadata.output_format);
  form.append("moderation", metadata.moderation);
  form.append("stream", String(metadata.stream));
  if (metadata.output_compression !== undefined) form.append("output_compression", String(metadata.output_compression));
  if (metadata.stream) form.append("partial_images", String(metadata.partial_images));
  return form;
}

module.exports = { buildEditFormData };
