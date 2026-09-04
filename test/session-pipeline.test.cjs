"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

// main.cjs requires Electron at module load; stub it out so the session
// orchestration can be exercised under plain Node. The stubbed app.whenReady()
// never settles, so the real bootstrap (window, IPC) never runs.
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
    createEmpty: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromPath: () => ({ isEmpty: () => true }),
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

async function withSessionHarness(run, connectionOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-session-"));
  const appStorage = new AppStorage(dir);
  await appStorage.initialize();
  await appStorage.saveConfig({
    activeConnectionId: "openai-default",
    connections: [{ ...DEFAULT_PROFILE, provider: "openai", model: "gpt-image-2", ...connectionOverrides }],
    downloadDirectory: "",
  });
  hooks.setStorage(appStorage);
  try {
    return await run({ storage: appStorage, dir });
  } finally {
    hooks.setStorage(null);
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

test("createSessionFromResult builds the first turn from a history entry", async () => {
  await withSessionHarness(async ({ storage, dir }) => {
    const { entry, resultPath, inputPath } = await seedEditEntry(storage, dir);
    const session = await hooks.createSessionFromResult({ entryId: entry.id, imageIndex: 1 });
    assert.ok(session.id, "session id generated");
    assert.equal(session.mode, "chained", "openai provider maps to chained");
    assert.equal(session.provider, "openai");
    assert.equal(session.model, "gpt-image-2");
    assert.equal(session.title, "把背景换成森林");
    assert.equal(session.turns.length, 1);
    const turn = session.turns[0];
    assert.equal(turn.index, 0);
    assert.equal(turn.entryId, entry.id);
    assert.equal(turn.prompt, "把背景换成森林");
    assert.equal(turn.chosen, 1, "requested image index becomes the chosen base");
    assert.deepEqual(turn.resultFiles, [resultPath, resultPath]);
    assert.equal(turn.inputSnapshot, inputPath);
    assert.ok(turn.resultUrls[1].startsWith("file://"), "hydrated urls for rendering");
  });
});

test("createSessionFromResult falls back to chosen 0 and records gemini as native", async () => {
  await withSessionHarness(async ({ storage, dir }) => {
    const { entry } = await seedEditEntry(storage, dir, { provider: "gemini", model: "gemini-3-pro-image-preview" });
    const session = await hooks.createSessionFromResult({ entryId: entry.id });
    assert.equal(session.mode, "native");
    assert.equal(session.turns[0].chosen, 0, "no imageIndex given → first image");
  });
});

test("createSessionFromResult rejects unknown entries and entries without images", async () => {
  await withSessionHarness(async ({ storage, dir }) => {
    await assert.rejects(
      () => hooks.createSessionFromResult({ entryId: "ghost" }),
      /原始记录不存在/,
    );
    const { entry } = await seedEditEntry(storage, dir, { images: [] });
    await assert.rejects(
      () => hooks.createSessionFromResult({ entryId: entry.id }),
      /没有结果图片/,
    );
  });
});

test("createSessionFromResult falls back to the active connection when the entry lacks provider info", async () => {
  await withSessionHarness(
    async ({ storage, dir }) => {
      const { entry } = await seedEditEntry(storage, dir, { provider: "", model: "" });
      const session = await hooks.createSessionFromResult({ entryId: entry.id });
      assert.equal(session.provider, "openai");
      assert.equal(session.model, "gpt-image-2");
    },
  );
});

test("chooseSessionBase updates the chosen index with validation", async () => {
  await withSessionHarness(async ({ storage, dir }) => {
    const { entry } = await seedEditEntry(storage, dir);
    const session = await hooks.createSessionFromResult({ entryId: entry.id, imageIndex: 0 });
    const updated = await hooks.chooseSessionBase({ id: session.id, turnIndex: 0, chosen: 1 });
    assert.equal(updated.turns[0].chosen, 1);
    await assert.rejects(() => hooks.chooseSessionBase({ id: session.id, turnIndex: 0, chosen: 9 }), /基准图编号无效/);
    await assert.rejects(() => hooks.chooseSessionBase({ id: session.id, turnIndex: 5, chosen: 0 }), /轮次不存在/);
    await assert.rejects(() => hooks.chooseSessionBase({ id: "ghost", turnIndex: 0, chosen: 0 }), /会话不存在/);
  });
});

test("deleteSessionEntry removes the index and tolerates missing media", async () => {
  await withSessionHarness(async ({ storage, dir }) => {
    const { entry } = await seedEditEntry(storage, dir);
    const session = await hooks.createSessionFromResult({ entryId: entry.id });
    const outcome = await hooks.deleteSessionEntry(session.id);
    assert.deepEqual(outcome, { deleted: true });
    assert.equal(await storage.getSession(session.id), null);
    assert.deepEqual(await hooks.deleteSessionEntry(session.id), { deleted: false });
    assert.deepEqual(await hooks.deleteSessionEntry("ghost"), { deleted: false });
  });
});
