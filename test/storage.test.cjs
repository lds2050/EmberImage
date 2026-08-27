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
    const stat = await fs.stat(storage.deviceKeyPath);
    assert.equal(stat.mode & 0o777, 0o600);
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
