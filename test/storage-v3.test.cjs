"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AppStorage, DEFAULT_PROFILE } = require("../src/main/storage.cjs");

async function withStorage(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-v3-"));
  const storage = new AppStorage(directory);
  await storage.initialize();
  try { await run(storage, directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("DEFAULT_PROFILE tracks unknown capabilities", () => {
  assert.equal(DEFAULT_PROFILE.generationCapability, "unknown");
  assert.equal(DEFAULT_PROFILE.editCapability, "unknown");
});

test("migrates a legacy history array into the v3 wrapper", async () => {
  await withStorage(async (storage, directory) => {
    const legacy = [
      { id: "a", prompt: "old one", images: [] },
      { id: "b", prompt: "old two", images: [] },
    ];
    await fs.writeFile(path.join(directory, "history.json"), JSON.stringify(legacy));

    const fresh = new AppStorage(directory);
    await fresh.initialize();

    const raw = JSON.parse(await fs.readFile(path.join(directory, "history.json"), "utf8"));
    assert.equal(raw.version, 3);
    assert.equal(raw.entries.length, 2);
    assert.equal(raw.entries[0].operation, "generate");
    assert.equal(raw.entries[0].editMode, "");
    assert.deepEqual(raw.entries[0].inputs, []);
    assert.equal(raw.entries[0].mask, null);
    assert.equal(raw.entries[0].prompt, "old one");

    const listed = await fresh.listHistory();
    assert.equal(listed.length, 2);
  });
});

test("passes through existing v3 history and preserves edit fields", async () => {
  await withStorage(async (storage) => {
    const editEntry = {
      id: "edit-1",
      operation: "edit",
      editMode: "mask",
      prompt: "局部改一下",
      inputs: [{ id: "input-0", role: "base", storedPath: "/x", mimeType: "image/png", width: 8, height: 8, bytes: 1 }],
      mask: { storedPath: "/m", width: 8, height: 8, bytes: 1 },
      images: [],
    };
    await storage.addHistory(editEntry);

    const raw = JSON.parse(await fs.readFile(storage.historyPath, "utf8"));
    assert.equal(raw.version, 3);
    assert.equal(raw.entries[0].operation, "edit");
    assert.equal(raw.entries[0].editMode, "mask");
    assert.equal(raw.entries[0].inputs.length, 1);

    const listed = await storage.listHistory();
    assert.equal(listed[0].operation, "edit");
  });
});

test("addHistory back-fills generate defaults on plain entries", async () => {
  await withStorage(async (storage) => {
    await storage.addHistory({ id: "gen-1", prompt: "hi", images: [] });
    const [entry] = await storage.listHistory();
    assert.equal(entry.operation, "generate");
    assert.equal(entry.editMode, "");
    assert.deepEqual(entry.inputs, []);
    assert.equal(entry.mask, null);
  });
});

test("clearHistory empties the index but keeps the v3 wrapper", async () => {
  await withStorage(async (storage) => {
    await storage.addHistory({ id: "gen-1", prompt: "hi", images: [] });
    await storage.clearHistory();
    const raw = JSON.parse(await fs.readFile(storage.historyPath, "utf8"));
    assert.equal(raw.version, 3);
    assert.deepEqual(raw.entries, []);
  });
});

test("task temp dir lifecycle: create, promote, clean", async () => {
  await withStorage(async (storage) => {
    const tempDir = await storage.createTaskTempDir("task-123");
    await fs.writeFile(path.join(tempDir, "input-0.png"), Buffer.from([1, 2, 3]));

    const mediaDir = await storage.promoteTaskMedia("task-123", "task-123");
    const promoted = await fs.readFile(path.join(mediaDir, "input-0.png"));
    assert.deepEqual(promoted, Buffer.from([1, 2, 3]));

    await assert.rejects(fs.access(tempDir));

    const other = await storage.createTaskTempDir("task-999");
    await fs.writeFile(path.join(other, "input-0.png"), Buffer.from([9]));
    await storage.cleanTaskTempDir("task-999");
    await assert.rejects(fs.access(other));
  });
});

test("writeThumbnail stores bytes in the thumbs directory", async () => {
  await withStorage(async (storage) => {
    const thumbPath = await storage.writeThumbnail("abc.jpg", Buffer.from([7, 7]));
    assert.equal(path.dirname(thumbPath), storage.thumbsDirectory);
    assert.deepEqual(await fs.readFile(thumbPath), Buffer.from([7, 7]));
  });
});

test("initialize clears orphaned tmp and thumbs content from previous sessions", async () => {
  await withStorage(async (storage) => {
    await fs.mkdir(path.join(storage.tmpDirectory, "assets"), { recursive: true });
    await fs.writeFile(path.join(storage.tmpDirectory, "assets", "staged.jpg"), Buffer.from([1]));
    const leftoverTask = await storage.createTaskTempDir("task-leftover");
    await fs.writeFile(path.join(leftoverTask, "input-0.png"), Buffer.from([9]));
    await storage.writeThumbnail("old.jpg", Buffer.from([2]));

    const restarted = new AppStorage(storage.rootDirectory);
    await restarted.initialize();

    assert.deepEqual(await fs.readdir(storage.tmpDirectory), []);
    assert.deepEqual(await fs.readdir(storage.thumbsDirectory), []);
    assert.equal((await fs.stat(storage.tmpDirectory)).mode & 0o777, 0o700);
  });
});

test("assertAllowedPath rejects paths outside the root", async () => {
  await withStorage(async (storage) => {
    const inside = path.join(storage.historyMediaDirectory, "entry-1", "input-0.png");
    assert.equal(storage.assertAllowedPath(inside, storage.historyMediaDirectory), path.resolve(inside));
    assert.throws(() => storage.assertAllowedPath("/etc/passwd", storage.historyMediaDirectory));
  });
});
