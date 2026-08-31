"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

// main.cjs requires Electron at module load; stub it out so the request
// pipeline can be exercised under plain Node. The stubbed app.whenReady()
// never settles, so the real bootstrap (window, IPC) never runs.
let nativeImageBehavior = null;
function defaultNativeImage() {
  return { isEmpty: () => true };
}
const electronStub = {
  app: {
    setPath() {},
    getPath: () => os.tmpdir(),
    whenReady: () => new Promise(() => {}),
    on() {},
    quit() {},
    getVersion: () => "0.0.0",
    dock: { setIcon() {} },
  },
  BrowserWindow: class {},
  ClipboardItem: class {},
  clipboard: { write() {}, writeText() {} },
  dialog: {},
  ipcMain: { handle() {}, on() {} },
  shell: {},
  nativeImage: {
    createEmpty: () => defaultNativeImage(),
    createFromBuffer: () => (nativeImageBehavior ? nativeImageBehavior.fromBuffer() : defaultNativeImage()),
    createFromPath: () => (nativeImageBehavior ? nativeImageBehavior.fromPath() : defaultNativeImage()),
  },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") return electronStub;
  return originalLoad.apply(this, [request, ...rest]);
};

const hooks = require("../src/main/main.cjs").__testing;
const { AppStorage, DEFAULT_PROFILE } = require("../src/main/storage.cjs");

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function editRequest(taskId, overrides = {}) {
  return {
    taskId,
    assetIds: ["asset-1"],
    parameters: {
      prompt: "把主图背景换成森林",
      size: "1024x1024",
      quality: "auto",
      n: 1,
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      stream: false,
      partialImages: 0,
      ...overrides,
    },
  };
}

function neverRespondHandler() {
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Headers sent, body never finished: the client keeps waiting.
  };
}

async function withEditHarness(handler, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-edit-"));
  const appStorage = new AppStorage(dir);
  await appStorage.initialize();
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await appStorage.saveConfig({
    activeConnectionId: "openai-default",
    connections: [{ ...DEFAULT_PROFILE, baseUrl, requestTimeoutSeconds: 30 }],
    downloadDirectory: "",
  });
  hooks.setStorage(appStorage);
  hooks.sessionApiKeys.set("openai-default", "test-key");
  const assetPath = path.join(dir, "input.png");
  await fs.writeFile(assetPath, PNG_BYTES);
  const thumbPath = path.join(dir, "thumb.jpg");
  await fs.writeFile(thumbPath, PNG_BYTES);
  hooks.assetRegistry.set("asset-1", {
    id: "asset-1",
    filePath: assetPath,
    fileName: "input.png",
    mime: "image/png",
    width: 64,
    height: 64,
    bytes: PNG_BYTES.length,
    thumbnailPath: thumbPath,
    ownsFile: false,
  });
  const partials = [];
  const sender = { isDestroyed: () => false, send: (channel, payload) => partials.push({ channel, payload }) };
  try {
    return await run({ storage: appStorage, port, baseUrl, dir, sender, partials });
  } finally {
    hooks.sessionApiKeys.clear();
    hooks.assetRegistry.clear();
    hooks.setStorage(null);
    hooks.setTimeoutOverrideMs(null);
    nativeImageBehavior = null;
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("createEdit writes a hydrated v3 history entry from a base64 response", async () => {
  await withEditHarness(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json", "x-request-id": "req-1" });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }], usage: { input_tokens: 5 } }));
      });
    },
    async ({ storage, sender }) => {
      const entry = await hooks.createEdit(editRequest("task-base64"), sender);
      assert.equal(entry.operation, "edit");
      assert.equal(entry.editMode, "full");
      assert.equal(entry.inputs.length, 1);
      assert.equal(entry.inputs[0].role, "base");
      assert.ok(entry.inputs[0].previewUrl.startsWith("file://"));
      await fs.access(entry.inputs[0].storedPath);
      assert.equal(path.dirname(entry.inputs[0].storedPath), path.join(storage.historyMediaDirectory, "task-base64"));
      assert.equal(entry.images.length, 1);
      const written = await fs.readFile(entry.images[0].path);
      assert.deepEqual(written, PNG_BYTES);
      assert.equal(entry.requestId, "req-1");
      assert.deepEqual(entry.usage, { input_tokens: 5 });

      const history = await storage.listHistory();
      assert.equal(history.length, 1);
      const config = await storage.loadConfig();
      assert.equal(config.connections[0].editCapability, "supported");
      // Task temp dir is promoted away, so nothing lingers in tmp.
      await assert.rejects(fs.access(path.join(storage.tmpDirectory, "task-base64")));
      await fs.access(path.join(storage.historyMediaDirectory, "task-base64"));
    }
  );
});

test("createEdit downloads URL results from the mock server", async () => {
  await withEditHarness(
    (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG_BYTES);
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${req.socket.localPort}/result.png` }] }));
      });
    },
    async ({ sender }) => {
      const entry = await hooks.createEdit(editRequest("task-url"), sender);
      const written = await fs.readFile(entry.images[0].path);
      assert.deepEqual(written, PNG_BYTES);
    }
  );
});

test("createEdit streams SSE partials over the shared generation channel", async () => {
  await withEditHarness(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const partial = { type: "image_generation.partial_image", partial_image_index: 0, b64_json: PNG_BYTES.toString("base64") };
        const completed = { type: "image_generation.completed", b64_json: PNG_BYTES.toString("base64"), usage: { output_tokens: 9 } };
        res.write(`event: image_generation.partial_image\ndata: ${JSON.stringify(partial)}\n\n`);
        res.write(`event: image_generation.completed\ndata: ${JSON.stringify(completed)}\n\n`);
        res.end();
      });
    },
    async ({ sender, partials }) => {
      const entry = await hooks.createEdit(editRequest("task-sse", { stream: true, partialImages: 2 }), sender);
      assert.equal(partials.length, 1);
      assert.equal(partials[0].channel, "generation:partial");
      assert.equal(partials[0].payload.taskId, "task-sse");
      assert.ok(partials[0].payload.previewUrl.startsWith("data:image/png;base64,"));
      assert.equal(entry.images.length, 1);
      assert.deepEqual(entry.usage, { output_tokens: 9 });
      assert.equal(entry.parameters.stream, true);
    }
  );
});

test("createEdit marks the connection editCapability unsupported on 404", async () => {
  await withEditHarness(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not Found", code: "not_found" } }));
      });
    },
    async ({ storage, sender }) => {
      await assert.rejects(hooks.createEdit(editRequest("task-404"), sender), (error) => error.status === 404);
      const config = await storage.loadConfig();
      assert.equal(config.connections[0].editCapability, "unsupported");
      assert.equal((await storage.listHistory()).length, 0);
      await assert.rejects(fs.access(path.join(storage.tmpDirectory, "task-404")));
    }
  );
});

test("createEdit keeps editCapability unknown on 401", async () => {
  await withEditHarness(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid key" } }));
      });
    },
    async ({ storage, sender }) => {
      await assert.rejects(hooks.createEdit(editRequest("task-401"), sender), (error) => error.code === "authentication_error");
      const config = await storage.loadConfig();
      assert.equal(config.connections[0].editCapability, "unknown");
      assert.equal((await storage.listHistory()).length, 0);
    }
  );
});

test("createEdit can be cancelled mid-flight and logs the cancellation", async () => {
  await withEditHarness(
    neverRespondHandler(),
    async ({ storage, sender }) => {
      const pending = hooks.createEdit(editRequest("task-cancel"), sender);
      setTimeout(() => hooks.cancelTask("task-cancel"), 40);
      await assert.rejects(pending, (error) => error.code === "cancelled");
      assert.equal(hooks.getActiveRequestTaskId(), null);
      const logs = await storage.listLogs();
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, "cancelled");
      assert.equal(logs[0].type, "image_edit");
      assert.equal((await storage.listHistory()).length, 0);
    }
  );
});

test("createEdit times out when the server never responds", async () => {
  await withEditHarness(
    neverRespondHandler(),
    async ({ storage, sender }) => {
      hooks.setTimeoutOverrideMs(150);
      await assert.rejects(hooks.createEdit(editRequest("task-timeout"), sender), (error) => error.code === "timeout");
      assert.equal(hooks.getActiveRequestTaskId(), null);
      assert.equal((await storage.listHistory()).length, 0);
    }
  );
});

test("single-flight blocks a second request until the first settles", async () => {
  await withEditHarness(
    neverRespondHandler(),
    async ({ sender }) => {
      const first = hooks.createEdit(editRequest("task-first"), sender);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await assert.rejects(hooks.createEdit(editRequest("task-second"), sender), (error) => error.code === "busy");
      hooks.cancelTask("task-first");
      await assert.rejects(first, (error) => error.code === "cancelled");
      assert.equal(hooks.getActiveRequestTaskId(), null);
      // After settling, a new request is allowed again.
      assert.equal(hooks.getActiveRequestTaskId(), null);
    }
  );
});

function maskImageStub(width, height) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toJPEG: () => Buffer.from([0xff, 0xd8]),
    toPNG: () => PNG_BYTES,
  };
}

function successJsonHandler(captured = {}) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured.contentType = req.headers["content-type"];
      captured.body = Buffer.concat(chunks).toString("latin1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }));
    });
  };
}

async function registerMaskAsset(dir, id, width, height) {
  const maskPath = path.join(dir, `${id}.png`);
  await fs.writeFile(maskPath, PNG_BYTES);
  hooks.assetRegistry.set(id, {
    id,
    filePath: maskPath,
    fileName: `${id}.png`,
    mime: "image/png",
    width,
    height,
    bytes: PNG_BYTES.length,
    thumbnailPath: path.join(dir, `${id}-thumb.jpg`),
    ownsFile: false,
  });
}

test("saveMask registers a mask asset when dimensions match the base", async () => {
  await withEditHarness(neverRespondHandler(), async () => {
    nativeImageBehavior = { fromBuffer: () => maskImageStub(64, 64), fromPath: () => maskImageStub(64, 64) };
    const result = await hooks.saveMask({ buffer: PNG_BYTES, baseAssetId: "asset-1" });
    assert.ok(result.maskAsset.id);
    assert.equal(result.maskAsset.mime, "image/png");
    assert.equal(result.maskAsset.width, 64);
    assert.equal(result.maskAsset.height, 64);
    assert.ok(hooks.assetRegistry.has(result.maskAsset.id));
  });
});

test("saveMask rejects a mask whose size differs from the base", async () => {
  await withEditHarness(neverRespondHandler(), async () => {
    nativeImageBehavior = { fromBuffer: () => maskImageStub(32, 32), fromPath: () => maskImageStub(32, 32) };
    await assert.rejects(
      hooks.saveMask({ buffer: PNG_BYTES, baseAssetId: "asset-1" }),
      (error) => error.code === "mask_size_mismatch"
    );
  });
});

test("createEdit sends the mask field and records editMode mask", async () => {
  const captured = {};
  await withEditHarness(
    successJsonHandler(captured),
    async ({ storage, sender, dir }) => {
      await registerMaskAsset(dir, "mask-1", 64, 64);
      const request = editRequest("task-mask");
      request.maskAssetId = "mask-1";
      const entry = await hooks.createEdit(request, sender);
      assert.equal(entry.editMode, "mask");
      assert.ok(entry.mask);
      await fs.access(entry.mask.storedPath);
      assert.ok(captured.contentType.startsWith("multipart/form-data"));
      assert.ok(captured.body.includes('name="mask"'));
      assert.ok(captured.body.includes('name="image[]"'));
      const config = await storage.loadConfig();
      assert.equal(config.connections[0].editCapability, "supported");
    }
  );
});

test("createEdit converts a JPEG base to PNG when a mask is present", async () => {
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  await withEditHarness(
    successJsonHandler(),
    async ({ sender, dir }) => {
      nativeImageBehavior = { fromBuffer: () => maskImageStub(64, 64), fromPath: () => maskImageStub(64, 64) };
      const basePath = path.join(dir, "base.jpg");
      await fs.writeFile(basePath, JPEG_BYTES);
      hooks.assetRegistry.set("asset-1", {
        id: "asset-1",
        filePath: basePath,
        fileName: "base.jpg",
        mime: "image/jpeg",
        width: 64,
        height: 64,
        bytes: JPEG_BYTES.length,
        thumbnailPath: path.join(dir, "thumb.jpg"),
        ownsFile: false,
      });
      await registerMaskAsset(dir, "mask-2", 64, 64);
      const request = editRequest("task-convert");
      request.maskAssetId = "mask-2";
      const entry = await hooks.createEdit(request, sender);
      assert.equal(entry.inputs[0].mimeType, "image/png");
      assert.ok(entry.inputs[0].storedPath.endsWith("input-0.png"));
      const stored = await fs.readFile(entry.inputs[0].storedPath);
      assert.deepEqual(stored, PNG_BYTES);
    }
  );
});

test("createEdit rejects a mask that does not match the base dimensions", async () => {
  await withEditHarness(
    neverRespondHandler(),
    async ({ storage, sender, dir }) => {
      await registerMaskAsset(dir, "mask-bad", 32, 32);
      const request = editRequest("task-mismatch");
      request.maskAssetId = "mask-bad";
      await assert.rejects(hooks.createEdit(request, sender), (error) => error.code === "mask_size_mismatch");
      assert.equal((await storage.listHistory()).length, 0);
    }
  );
});
