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

async function withSessionEditHarness(handler, run, profileOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-edit-session-"));
  const appStorage = new AppStorage(dir);
  await appStorage.initialize();
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await appStorage.saveConfig({
    activeConnectionId: "openai-default",
    connections: [{ ...DEFAULT_PROFILE, baseUrl, requestTimeoutSeconds: 30, ...profileOverrides }],
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
      assert.equal(typeof turn.createdAt, "string", "sent timestamp for the user bubble");
      assert.equal(turn.completedAt, entry.createdAt, "completion timestamp for the ai bubble");
      assert.ok(turn.parameters && Number(turn.parameters.n) >= 1, "turn snapshots its parameters");

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
  let onBodyReceived;
  const bodyReceived = new Promise((resolve) => { onBodyReceived = resolve; });
  await withSessionEditHarness(
    (req, _res) => {
      // Drain the request body and signal when it fully arrived, then keep
      // the response hanging: the client cancels while waiting for headers.
      // Cancelling only after the upload reached the server keeps undici's
      // abort path out of body-stream enqueue races on slow CI machines.
      req.resume();
      req.on("end", onBodyReceived);
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
      // Let the upload finish before aborting so the abort lands in the
      // "waiting for response" phase, not mid-body-stream.
      const timeout = setTimeout(() => onBodyReceived(new Error("request body never reached the test server")), 5000);
      timeout.unref();
      const failure = await bodyReceived;
      if (failure) throw failure;
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

test("a native-mode session refuses to continue under a non-Gemini connection (D6)", async () => {
  const bodies = [];
  await withSessionEditHarness(
    jsonEditResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
      const session = await hooks.createSessionFromResult({ entryId: entry.id });
      assert.equal(session.mode, "native");

      // PRD D6: native sessions may only continue under a Gemini connection —
      // chained feed-back would silently drop the conversation context.
      await assert.rejects(
        hooks.sessionAppendTurn({ id: session.id, prompt: "继续调整", taskId: "task-native" }, sender),
        (error) => error.code === "session_native_requires_gemini",
      );
      assert.equal(bodies.length, 0, "D6 blocks native continuation before any API traffic");
    },
  );
});

const GEMINI_PROFILE = { provider: "gemini", model: "gemini-3-pro-image-preview" };

function geminiImageResponse(bodyOf) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodyOf(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [
              { inlineData: { mimeType: "image/png", data: PNG_B64 } },
              { thoughtSignature: "sig-turn" },
            ],
          },
          finishReason: "STOP",
        }],
        usageMetadata: { totalBillableCharacterCount: 12 },
      }));
    });
  };
}

test("a native session replays stored contents and echoes thoughtSignature verbatim", async () => {
  const bodies = [];
  await withSessionEditHarness(
    geminiImageResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry: seedEntry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
      const session = await hooks.createSessionFromResult({ entryId: seedEntry.id });
      assert.equal(session.mode, "native");

      // Turn 1: fresh session — one user turn carrying the base image + prompt.
      const first = await hooks.sessionAppendTurn({ id: session.id, prompt: "调成黄昏", taskId: "task-native-1" }, sender);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].contents.length, 1);
      assert.equal(bodies[0].contents[0].role, "user");
      assert.equal(bodies[0].contents[0].parts[0].inlineData.data, PNG_B64);
      assert.equal(bodies[0].contents[0].parts[1].text, "调成黄昏");
      assert.ok(bodies[0].generationConfig.responseModalities.includes("IMAGE"));
      assert.equal(first.entry.sessionId, session.id);
      assert.equal(first.entry.turnIndex, 1);
      assert.match(first.session.turns[1].nativeReplyFile, /^turn-1\.json$/);

      // The verbatim reply (thoughtSignature included) is persisted for replay.
      const stored = await storage.readSessionNativeReply(session.id, first.session.turns[1].nativeReplyFile);
      assert.equal(stored.role, "model");
      assert.equal(stored.parts[1].thoughtSignature, "sig-turn");

      // Turn 2: stored reply echoed verbatim, the new turn is text-only.
      const second = await hooks.sessionAppendTurn({ id: session.id, prompt: "再加点雾", taskId: "task-native-2" }, sender);
      assert.equal(bodies.length, 2);
      const contents = bodies[1].contents;
      assert.equal(contents.length, 3);
      assert.equal(contents[0].role, "user");
      assert.equal(contents[0].parts[0].inlineData.data, PNG_B64, "suffix restart re-attaches its input image");
      assert.equal(contents[0].parts[1].text, "调成黄昏");
      assert.equal(contents[1].role, "model");
      assert.equal(contents[1].parts[1].thoughtSignature, "sig-turn", "reply echoed verbatim");
      assert.deepEqual(contents[2], { role: "user", parts: [{ text: "再加点雾" }] });
      assert.equal(second.session.turns[2].nativeReplyFile, "turn-2.json");
      assert.equal(second.entry.turnIndex, 2);
    },
    GEMINI_PROFILE,
  );
});

test("a native fork attaches the chosen image as a fresh user turn", async () => {
  const bodies = [];
  await withSessionEditHarness(
    geminiImageResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry: seedEntry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
      const session = await hooks.createSessionFromResult({ entryId: seedEntry.id });
      await hooks.sessionAppendTurn({ id: session.id, prompt: "调成黄昏", taskId: "task-fork-1" }, sender);
      assert.equal(bodies.length, 1);

      // Fork to turn 0's second result: history still replays, but the chosen
      // image rides along in the new user turn.
      await hooks.sessionAppendTurn({ id: session.id, prompt: "基于最早的结果重画", taskId: "task-fork-2", baseTurn: 0, baseChosen: 1 }, sender);
      const contents = bodies[1].contents;
      assert.equal(contents.length, 3, "replayed user1 + model1 + fork user with image");
      assert.deepEqual(contents[2], { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }, { text: "基于最早的结果重画" }] });
    },
    GEMINI_PROFILE,
  );
});

test("native bodies over the 50MB limit are rejected before any traffic (D5)", async () => {
  const bodies = [];
  await withSessionEditHarness(
    geminiImageResponse((body) => bodies.push(body)),
    async ({ storage, dir, sender }) => {
      const { entry: seedEntry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
      const session = await hooks.createSessionFromResult({ entryId: seedEntry.id });
      const resultPath = session.turns[0].resultFiles[0];
      const oversized = "A".repeat(51 * 1024 * 1024);
      await storage.writeSessionNativeReply(session.id, 1, { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: oversized } }] });
      await storage.updateSession(session.id, {
        turns: [...session.turns, {
          index: 1,
          entryId: seedEntry.id,
          prompt: "填充轮",
          baseTurn: 0,
          inputSnapshot: resultPath,
          resultFiles: [resultPath],
          chosen: 0,
          nativeReplyFile: "turn-1.json",
        }],
      });
      await assert.rejects(
        hooks.sessionAppendTurn({ id: session.id, prompt: "继续", taskId: "task-too-large" }, sender),
        (error) => error.code === "session_too_large",
      );
      assert.equal(bodies.length, 0, "D5 rejects before any API traffic");
    },
    GEMINI_PROFILE,
  );
});
