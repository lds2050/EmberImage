"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AppStorage } = require("../src/main/storage.cjs");

async function withStorage(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-storage-"));
  const storage = new AppStorage(directory);
  await storage.initialize();
  try { await run(storage, directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("migrates a V0.1 single connection without losing its encrypted key", async () => {
  await withStorage(async (storage, directory) => {
    const legacy = {
      baseUrl: "https://example.com/v1",
      model: "legacy-image-model",
      keyStorage: "encrypted",
      encryptedKey: { salt: "salt", iv: "iv", authTag: "tag", ciphertext: "cipher" },
    };
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(legacy));

    const config = await storage.loadConfig();
    assert.equal(config.version, 2);
    assert.equal(config.connections.length, 1);
    assert.equal(config.connections[0].baseUrl, legacy.baseUrl);
    assert.equal(config.connections[0].model, legacy.model);
    assert.deepEqual(config.connections[0].encryptedKey, legacy.encryptedKey);
  });
});

test("stores multiple independent connection URLs and active selection", async () => {
  await withStorage(async (storage) => {
    const initial = await storage.loadConfig();
    const custom = {
      ...initial.connections[0],
      id: "custom-service",
      name: "自定义服务",
      baseUrl: "https://images.example.com/v1",
      requestTimeoutSeconds: 420,
      streamEnabled: true,
    };
    await storage.saveConfig({ ...initial, activeConnectionId: custom.id, connections: [initial.connections[0], custom] });

    const reloaded = await storage.loadConfig();
    assert.equal(reloaded.activeConnectionId, custom.id);
    assert.equal(reloaded.connections[0].baseUrl, "https://api.openai.com/v1");
    assert.equal(reloaded.connections[1].baseUrl, "https://images.example.com/v1");
    assert.equal(reloaded.connections[1].requestTimeoutSeconds, 420);
    assert.equal(reloaded.connections[1].streamEnabled, true);
  });
});

test("creates and reuses a permission-restricted device encryption key", async () => {
  await withStorage(async (storage) => {
    const first = await storage.getOrCreateDeviceKey();
    const second = await storage.getOrCreateDeviceKey();
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    if (process.platform !== "win32") {
      const stat = await fs.stat(storage.deviceKeyPath);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  });
});

test("updates favorites and keeps request logs bounded", async () => {
  await withStorage(async (storage) => {
    await storage.addHistory({ id: "one", favorite: false, images: [] });
    const updated = await storage.updateHistory("one", { favorite: true });
    assert.equal(updated.favorite, true);

    for (let index = 0; index < 505; index += 1) await storage.addLog({ id: String(index) });
    const logs = await storage.listLogs();
    assert.equal(logs.length, 500);
    assert.equal(logs[0].id, "504");
    assert.equal(logs.at(-1).id, "5");
  });
});

test("serializes concurrent writes to the same JSON file without losing entries", async () => {
  await withStorage(async (storage) => {
    await Promise.all(Array.from({ length: 40 }, (_, index) => storage.addLog({ id: `log-${index}` })));
    const logs = await storage.listLogs();
    assert.equal(new Set(logs.map((log) => log.id)).size, 40);

    await Promise.all(Array.from({ length: 10 }, (_, index) => storage.addHistory({ id: `entry-${index}`, favorite: false, images: [] })));
    await Promise.all(Array.from({ length: 10 }, (_, index) => storage.updateHistory(`entry-${index}`, { favorite: true })));
    const history = await storage.listHistory();
    assert.equal(history.length, 10);
    assert.ok(history.every((entry) => entry.favorite === true));
  });
});

test("quarantines corrupt JSON instead of failing forever", async () => {
  await withStorage(async (storage, directory) => {
    await fs.writeFile(path.join(directory, "history.json"), "{not valid json");
    const history = await storage.listHistory();
    assert.deepEqual(history, []);
    const entries = await fs.readdir(directory);
    assert.ok(entries.some((name) => name.startsWith("history.json.corrupt-")));
    assert.ok(!entries.includes("history.json"));

    await storage.addHistory({ id: "after-recovery", favorite: false, images: [] });
    assert.equal((await storage.listHistory()).length, 1);
  });
});

test("prompts: CRUD round trip with category normalization", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addPrompt({ text: "  一只戴帽子的柴犬，胶片质感  ", category: "   ", sourceHistoryId: "history-1" });
    assert.equal(added.text, "一只戴帽子的柴犬，胶片质感");
    assert.equal(added.category, "未分类");
    assert.equal(added.sourceHistoryId, "history-1");
    assert.ok(added.id);
    assert.ok(added.createdAt && added.updatedAt);

    const updated = await storage.updatePrompt(added.id, { text: "两只柴犬", category: "  动物  " });
    assert.equal(updated.text, "两只柴犬");
    assert.equal(updated.category, "动物");
    assert.equal(updated.createdAt, added.createdAt);
    assert.ok(updated.updatedAt >= added.updatedAt);

    assert.equal(await storage.updatePrompt("missing-id", { text: "x" }), null);

    const trimmedCategory = await storage.addPrompt({ text: "t", category: "x".repeat(30) });
    assert.equal(trimmedCategory.category, "x".repeat(24));

    assert.equal((await storage.listPrompts()).length, 2);
    assert.equal(await storage.removePrompt(added.id), true);
    assert.equal(await storage.removePrompt(added.id), false);
    assert.equal((await storage.listPrompts()).length, 1);
  });
});

test("prompts: rejects empty text, enforces the 500 limit and quarantines corrupt files", async () => {
  await withStorage(async (storage, directory) => {
    await assert.rejects(() => storage.addPrompt({ text: "   " }), /正文不能为空/);

    for (let index = 0; index < 500; index += 1) await storage.addPrompt({ text: `t-${index}` });
    assert.equal((await storage.listPrompts()).length, 500);
    await assert.rejects(() => storage.addPrompt({ text: "overflow" }), /已满/);

    await fs.writeFile(path.join(directory, "prompts.json"), "{broken");
    assert.deepEqual(await storage.listPrompts(), []);
    const entries = await fs.readdir(directory);
    assert.ok(entries.some((name) => name.startsWith("prompts.json.corrupt-")));

    const recovered = await storage.addPrompt({ text: "after-recovery" });
    assert.equal((await storage.listPrompts()).length, 1);
    assert.equal(recovered.category, "未分类");
  });
});

test("prompts: favorite, usage tracking and new entry defaults", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addPrompt({ text: "月光下的富士山" });
    assert.equal(added.favorite, false);
    assert.equal(added.usageCount, 0);
    assert.equal(added.lastUsedAt, null);

    const favored = await storage.setPromptFavorite(added.id, true);
    assert.equal(favored.favorite, true);
    assert.equal(favored.updatedAt, added.updatedAt, "favorite toggle must not touch updatedAt");
    assert.equal(await storage.setPromptFavorite("missing", true), null);

    const used = await storage.recordPromptUsage(added.id);
    assert.equal(used.usageCount, 1);
    assert.ok(used.lastUsedAt);
    const usedAgain = await storage.recordPromptUsage(added.id);
    assert.equal(usedAgain.usageCount, 2);
    assert.equal(usedAgain.updatedAt, added.updatedAt, "usage tracking must not touch updatedAt");
    assert.equal(await storage.recordPromptUsage("missing"), null);

    const legacy = JSON.parse(await fs.readFile(path.join(storage.rootDirectory, "prompts.json"), "utf8"));
    legacy.entries.push({ id: "legacy-1", text: "legacy entry", category: "旧", usageCount: "not-a-number", favorite: "yes" });
    await fs.writeFile(path.join(storage.rootDirectory, "prompts.json"), JSON.stringify(legacy));
    const listed = await storage.listPrompts();
    const legacyEntry = listed.find((entry) => entry.id === "legacy-1");
    assert.equal(legacyEntry.usageCount, 0);
    assert.equal(legacyEntry.favorite, false);
  });
});

test("prompts: bulk delete, bulk category move and category rename", async () => {
  await withStorage(async (storage) => {
    const first = await storage.addPrompt({ text: "一", category: "风景" });
    const second = await storage.addPrompt({ text: "二", category: "风景" });
    const third = await storage.addPrompt({ text: "三", category: "人像" });

    assert.equal(await storage.setPromptsCategory([first.id, second.id], "  自然 "), 2);
    assert.equal((await storage.listPrompts()).filter((entry) => entry.category === "自然").length, 2);
    assert.equal(await storage.setPromptsCategory([first.id], "风景"), 1);
    assert.equal(await storage.setPromptsCategory([first.id], "风景"), 0, "same category move is a no-op");
    assert.equal(await storage.setPromptsCategory(["missing"], "x"), 0);
    assert.equal(await storage.setPromptsCategory([third.id], ""), 1);
    assert.equal((await storage.listPrompts()).find((entry) => entry.id === third.id).category, "未分类");

    assert.equal(await storage.renamePromptCategory("风景", "风光"), 1);
    assert.equal((await storage.listPrompts()).find((entry) => entry.id === first.id).category, "风光");
    await assert.rejects(() => storage.renamePromptCategory("  ", "x"), /分类名不能为空/);

    assert.equal(await storage.removePrompts([first.id, second.id, "missing"]), 2);
    assert.equal((await storage.listPrompts()).length, 1);
    assert.equal(await storage.removePrompts([]), 0);
    assert.equal(third.text, "三");
  });
});
