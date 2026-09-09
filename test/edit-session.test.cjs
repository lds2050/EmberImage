"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

// main.cjs requires Electron at module load; stub it out so the session
// continuation pipeline can be exercised under plain Node. The stubbed
// app.whenReady() never settles, so the real bootstrap never runs.
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
  shell: { trashItem: async () => {} },
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
const A_BYTES = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const B_BYTES = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
const PNG_B64 = PNG_BYTES.toString("base64");

function fakeImage() {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 8, height: 8 }),
    resize: () => fakeImage(),
    toJPEG: () => Buffer.from("fake-jpeg"),
    toPNG: () => PNG_BYTES,
  };
}

function jsonEditResponse(bodyOf, extra) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodyOf(Buffer.concat(chunks));
      res.writeHead(200, { "Content-Type": "application/json", "x-request-id": "req-session" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 3 }, ...extra }));
    });
  };
}

async function withSessionEditHarness(handler, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-edit-session-"));
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
  nativeImageBehavior = { fromBuffer: fakeImage, fromPath: fakeImage };
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

let seedCounter = 0;

async function seedEditEntry(storage, dir, overrides = {}) {
  seedCounter += 1;
  const seed = String(seedCounter);
  const resultPath = path.join(dir, "results", `result-${seed}.png`);
  await fs.writeFile(resultPath, PNG_BYTES);
  const inputPath = path.join(dir, "history-media", `seed-${seed}`, "input-0.png");
  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(inputPath, PNG_BYTES);
  const entry = {
    id: `entry-${seed}`,
    operation: "edit",
    editMode: "full",
    createdAt: new Date().toISOString(),
    durationMs: 1200,
    prompt: "把背景换成森林",
    model: "gpt-image-2",
    provider: "openai",
    connectionId: "openai-default",
    favorite: false,
    inputs: [{ id: `input-${seed}`, role: "base", storedPath: inputPath, thumbnailPath: null, mimeType: "image/png", width: 8, height: 8, bytes: PNG_BYTES.length }],
    mask: null,
    parameters: { size: "1024x1024", quality: "auto", n: 2, stream: false },
    requestId: "",
    usage: null,
    images: [
      { id: `img-${seed}-1`, path: resultPath, filename: "a.png", format: "png", mime: "image/png", bytes: PNG_BYTES.length },
      { id: `img-${seed}-2`, path: resultPath, filename: "b.png", format: "png", mime: "image/png", bytes: PNG_BYTES.length },
    ],
    ...overrides,
  };
  await storage.addHistory(entry);
  return { entry, resultPath, inputPath };
}

test("sessionAppendTurn feeds the chosen base image back as the first input and records the turn", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry: seedEntry, resultPath } = await seedEditEntry(storage, dir);
      const session = await hooks.createSessionFromResult({ entryId: seedEntry.id, imageIndex: 0 });

      const { entry, session: updated } = await hooks.sessionAppendTurn(
        { id: session.id, prompt: "把人物往左移一点", taskId: "task-turn-1" },
        sender,
      );

      // The base image is the first (and only) uploaded input.
      assert.equal(bodies.length, 1);
      assert.ok(bodies[0].includes('filename="image-1.png"'), "base image uploaded as image-1");
      assert.ok(bodies[0].includes(PNG_BYTES), "uploaded bytes match the base image");

      // The continuation entry is stamped with the session back-reference.
      assert.equal(entry.sessionId, session.id);
      assert.equal(entry.turnIndex, 1);
      assert.equal(entry.parameters.stream, false);
      assert.equal(entry.images.length, 1);

      // The session grows by one chained turn.
      assert.equal(updated.turns.length, 2);
      const turn = updated.turns[1];
      assert.equal(turn.index, 1);
      assert.equal(turn.entryId, entry.id);
      assert.equal(turn.prompt, "把人物往左移一点");
      assert.equal(turn.baseTurn, 0);
      assert.equal(turn.inputSnapshot, resultPath);
      assert.equal(turn.resultFiles[0], entry.images[0].path);

      // The persisted history entry carries the back-reference too.
      const history = await storage.listHistory();
      const persisted = history.find((item) => item.id === entry.id);
      assert.equal(persisted.sessionId, session.id);
      assert.equal(persisted.turnIndex, 1);

      // The temporary asset registration is cleaned up.
      assert.equal(hooks.assetRegistry.size, 0);
    },
  );
});

test("sessionAppendTurn forks from an explicit turn and chosen image", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const fileA = path.join(dir, "results", "fork-a.png");
      const fileB = path.join(dir, "results", "fork-b.png");
      await fs.writeFile(fileA, A_BYTES);
      await fs.writeFile(fileB, B_BYTES);
      const session = await storage.addSession({
        title: "分叉会话",
        provider: "openai",
        model: "gpt-image-2",
        connectionId: "openai-default",
        mode: "chained",
        turns: [{ index: 0, entryId: "entry-x", prompt: "第一轮", baseTurn: null, inputSnapshot: fileA, resultFiles: [fileA, fileB], chosen: 0 }],
      });

      await hooks.sessionAppendTurn(
        { id: session.id, prompt: "以第二张为基础再改", taskId: "task-fork", baseTurn: 0, baseChosen: 1 },
        sender,
      );

      assert.equal(bodies.length, 1);
      assert.ok(bodies[0].includes(B_BYTES), "the explicitly chosen image is uploaded");
      assert.ok(!bodies[0].includes(A_BYTES), "the non-chosen image is not uploaded");

      const updated = await storage.getSession(session.id);
      assert.equal(updated.turns.length, 2);
      assert.equal(updated.turns[1].baseTurn, 0);
      assert.equal(updated.turns[1].inputSnapshot, fileB);
    },
  );
});

test("sessionAppendTurn rejects a full session before any API traffic", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry } = await seedEditEntry(storage, dir);
      const session = await hooks.createSessionFromResult({ entryId: entry.id });
      const fillerTurn = session.turns[0];
      const turns = Array.from({ length: 20 }, (_, index) => (index === 0 ? fillerTurn : { ...fillerTurn, index }));
      await storage.updateSession(session.id, { turns });
      assert.equal((await storage.getSession(session.id)).turns.length, 20);

      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: session.id, prompt: "再改一轮", taskId: "task-limit" }, sender),
        (error) => error.code === "session_turn_limit_reached" && /最多 20 轮/.test(error.message),
      );
      assert.equal(bodies.length, 0, "no request hit the API");
      assert.equal(hooks.getActiveRequestTaskId(), null);
    },
  );
});

test("sessionAppendTurn shares the single-flight lock with ordinary edits", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      await gate;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  };
  await withSessionEditHarness(
    handler,
    async ({ storage, dir, sender }) => {
      const { entry } = await seedEditEntry(storage, dir);
      const session = await hooks.createSessionFromResult({ entryId: entry.id });

      const first = hooks.sessionAppendTurn({ id: session.id, prompt: "第一笔续轮", taskId: "task-sf-1" }, sender);
      while (!hooks.getActiveRequestTaskId()) await new Promise((resolve) => setImmediate(resolve));

      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: session.id, prompt: "插队失败", taskId: "task-sf-2" }, sender),
        (error) => error.code === "busy",
      );

      release();
      const { session: updated } = await first;
      assert.equal(updated.turns.length, 2);
      assert.equal(hooks.getActiveRequestTaskId(), null, "lock released after completion");
    },
  );
});

test("cancelling a session turn releases the lock and reports cancelled", async () => {
  await withSessionEditHarness(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Headers sent, body never finished: the client keeps waiting.
    },
    async ({ storage, dir, sender }) => {
      const { entry } = await seedEditEntry(storage, dir);
      const session = await hooks.createSessionFromResult({ entryId: entry.id });

      const pending = hooks.sessionAppendTurn({ id: session.id, prompt: "等待中的续轮", taskId: "task-cancel" }, sender);
      // Wait until the request is cancellable: the AbortController is registered
      // only after the first awaited config load inside createEdit.
      while (!hooks.getActiveRequestTaskId() || !hooks.hasGenerationController("task-cancel")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      hooks.cancelTask("task-cancel");

      await assert.rejects(() => pending, (error) => error.code === "cancelled");
      assert.equal(hooks.getActiveRequestTaskId(), null, "lock released after cancel");
    },
  );
});

test("sessionAppendTurn validates prompt, session, base turn, and base file", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry, resultPath } = await seedEditEntry(storage, dir);
      const session = await hooks.createSessionFromResult({ entryId: entry.id });

      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: session.id, prompt: "   ", taskId: "task-v1" }, sender),
        (error) => error.code === "session_empty_prompt",
      );
      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: "ghost", prompt: "指令", taskId: "task-v2" }, sender),
        (error) => error.code === "session_missing",
      );
      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: session.id, prompt: "指令", taskId: "task-v3", baseTurn: 9 }, sender),
        (error) => error.code === "session_base_invalid",
      );

      // Point the turn at a result file that no longer exists on disk.
      await storage.updateSession(session.id, { turns: [{ index: 0, entryId: entry.id, prompt: "第一轮", baseTurn: null, inputSnapshot: resultPath, resultFiles: [path.join(dir, "results", "vanished.png")], chosen: 0 }] });
      await assert.rejects(
        () => hooks.sessionAppendTurn({ id: session.id, prompt: "指令", taskId: "task-v4" }, sender),
        (error) => error.code === "session_base_missing",
      );

      assert.equal(bodies.length, 0, "validation failures never reach the API");
      assert.equal(hooks.assetRegistry.size, 0);
    },
  );
});

test("a native-mode session continues through the chained pipeline in stage B", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
      const session = await hooks.createSessionFromResult({ entryId: entry.id });
      assert.equal(session.mode, "native");

      // Stage C will switch native sessions to real multi-turn contents; until
      // then the chained feed-back keeps every provider's session usable.
      const { session: updated } = await hooks.sessionAppendTurn(
        { id: session.id, prompt: "继续调整", taskId: "task-native" },
        sender,
      );
      assert.equal(bodies.length, 1);
      assert.equal(updated.turns.length, 2);
      assert.equal(updated.turns[1].baseTurn, 0);
    },
  );
});
