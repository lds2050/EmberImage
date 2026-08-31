"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const Validation = require("../src/shared/validation.js");
const { buildEditFormData } = require("../src/shared/edit-form.js");

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = {};
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captured.method = req.method;
        captured.headers = req.headers;
        captured.body = Buffer.concat(chunks).toString("latin1");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, captured, port: server.address().port }));
  });
}

function baseMetadata(overrides = {}) {
  return Validation.buildEditMetadata({
    model: "gpt-image-2",
    prompt: "把主图背景换成森林",
    size: "1024x1024",
    quality: "high",
    n: 1,
    background: "auto",
    outputFormat: "png",
    moderation: "auto",
    stream: false,
    imageCount: 1,
    ...overrides,
  });
}

test("edit multipart request sends ordered fields, repeated image[], and no input_fidelity", async () => {
  const { server, captured, port } = await startCaptureServer();
  try {
    const metadata = baseMetadata();
    const inputFiles = [
      { buffer: PNG_BYTES, name: "image-1.png", mime: "image/png" },
      { buffer: PNG_BYTES, name: "image-2.png", mime: "image/png" },
    ];
    const form = buildEditFormData(metadata, inputFiles, null);
    const response = await fetch(`http://127.0.0.1:${port}/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      body: form,
    });
    assert.equal(response.status, 200);

    assert.equal(captured.method, "POST");
    const contentType = captured.headers["content-type"] || "";
    assert.ok(contentType.startsWith("multipart/form-data"), contentType);
    assert.ok(contentType.includes("boundary="), contentType);
    assert.equal(captured.headers.authorization, "Bearer test-key");

    const body = captured.body;
    assert.ok(!body.includes("input_fidelity"));

    const occurrences = (needle) => body.split(needle).length - 1;
    assert.equal(occurrences('name="image[]"'), 2);
    assert.ok(body.includes('filename="image-1.png"'));
    assert.ok(body.includes('filename="image-2.png"'));

    const orderOf = (names) => names.map((name) => body.indexOf(`name="${name}"`));
    const positions = orderOf(["model", "prompt", "size", "quality", "n", "background", "output_format", "moderation", "stream"]);
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i - 1] !== -1 && positions[i - 1] < positions[i], `field order broken at ${["model", "prompt", "size", "quality", "n", "background", "output_format", "moderation", "stream"][i]}`);
    }
    assert.ok(body.indexOf('name="model"') < body.indexOf('name="image[]"'));
    assert.ok(!body.includes('name="output_compression"'));
    assert.ok(!body.includes('name="partial_images"'));
  } finally {
    server.close();
  }
});

test("edit multipart includes mask and webp compression, and partial_images when streaming", async () => {
  const { server, captured, port } = await startCaptureServer();
  try {
    const metadata = baseMetadata({ outputFormat: "webp", outputCompression: 75, stream: true, partialImages: 2 });
    const inputFiles = [{ buffer: PNG_BYTES, name: "image-1.png", mime: "image/png" }];
    const maskFile = { buffer: PNG_BYTES, name: "mask.png", mime: "image/png" };
    const form = buildEditFormData(metadata, inputFiles, maskFile);
    await fetch(`http://127.0.0.1:${port}/images/edits`, {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      body: form,
    });

    const body = captured.body;
    assert.ok(body.includes('name="mask"'));
    assert.ok(body.includes('filename="mask.png"'));
    assert.ok(body.includes('name="output_compression"'));
    assert.ok(body.includes("75"));
    assert.ok(body.includes('name="partial_images"'));
    assert.ok(body.includes('name="stream"'));
  } finally {
    server.close();
  }
});
