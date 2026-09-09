"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AppStorage } = require("../src/main/storage.cjs");

async function withStorage(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "emberimage-sessions-"));
  const storage = new AppStorage(directory);
  await storage.initialize();
  try { await run(storage, directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function sessionOverrides(overrides = {}) {
  return {
    title: "把背景换成森林",
    provider: "gemini",
    model: "gemini-3-pro-image-preview",
    connectionId: "conn-1",
    mode: "native",
    turns: [{
      index: 0,
      entryId: "entry-1",
      prompt: "把背景换成森林",
      baseTurn: null,
      inputSnapshot: "/media/input-0.png",
      resultFiles: ["/results/a.png", "/results/b.png"],
      chosen: 1,
    }],
    ...overrides,
  };
}

test("addSession normalizes fields and stamps timestamps", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addSession(sessionOverrides({ id: undefined, createdAt: undefined, updatedAt: undefined }));
    assert.ok(added.id, "id generated");
    assert.ok(added.createdAt && added.updatedAt, "timestamps stamped");
    assert.equal(added.mode, "native");
    assert.equal(added.turns.length, 1);
    assert.equal(added.turns[0].chosen, 1);
  });
});

test("addSession falls back to chained mode for unknown mode values", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addSession(sessionOverrides({ mode: "wild" }));
    assert.equal(added.mode, "chained");
  });
});

test("addSession rejects entries without turns", async () => {
  await withStorage(async (storage) => {
    await assert.rejects(
      () => storage.addSession(sessionOverrides({ turns: [] })),
      /至少需要一轮/,
    );
  });
});

test("addSession rejects invalid chosen index by resetting to zero", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addSession(sessionOverrides());
    added.turns[0].chosen = 99; // out of range on write-through via update
    const updated = await storage.updateSession(added.id, { turns: added.turns });
    assert.equal(updated.turns[0].chosen, 0);
  });
});

test("session list summaries drop nativeHistory and expose turnCount", async () => {
  await withStorage(async (storage) => {
    await storage.addSession(sessionOverrides({ nativeHistory: [{ role: "user", parts: [{ text: "hi" }] }] }));
    const list = await storage.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].turnCount, 1);
    assert.equal(list[0].title, "把背景换成森林");
    assert.equal("nativeHistory" in list[0], false);
    const detail = await storage.getSession(list[0].id);
    assert.deepEqual(detail.nativeHistory, [{ role: "user", parts: [{ text: "hi" }] }]);
  });
});

test("getSession returns null for unknown ids", async () => {
  await withStorage(async (storage) => {
    assert.equal(await storage.getSession("nope"), null);
  });
});

test("updateSession merges patches, preserves createdAt, refreshes updatedAt", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addSession(sessionOverrides());
    const before = { createdAt: added.createdAt, updatedAt: added.updatedAt };
    const updated = await storage.updateSession(added.id, { title: "新标题" });
    assert.equal(updated.title, "新标题");
    assert.equal(updated.createdAt, before.createdAt);
    assert.notEqual(updated.updatedAt, before.updatedAt);
    assert.equal(updated.provider, "gemini", "untouched fields preserved");
  });
});

test("updateSession returns null for unknown ids", async () => {
  await withStorage(async (storage) => {
    assert.equal(await storage.updateSession("nope", { title: "x" }), null);
  });
});

test("appendSessionTurn appends with automatic index and refreshes updatedAt", async () => {
  await withStorage(async (storage) => {
    const added = await storage.addSession(sessionOverrides());
    const updated = await storage.appendSessionTurn(added.id, {
      entryId: "entry-2",
      prompt: "人物再往左一点",
      resultFiles: ["/results/c.png"],
    });
    assert.equal(updated.turns.length, 2);
    assert.equal(updated.turns[1].index, 1);
    assert.equal(updated.turns[1].prompt, "人物再往左一点");
    assert.equal(updated.turns[1].baseTurn, null);
    assert.ok(updated.updatedAt >= added.updatedAt);
  });
});

test("appendSessionTurn enforces the 20-turn limit", async () => {
  await withStorage(async (storage) => {
    const turns = Array.from({ length: 20 }, (_, index) => ({
      index,
      entryId: `entry-${index}`,
      prompt: `turn ${index}`,
      resultFiles: [`/results/${index}.png`],
      chosen: 0,
    }));
    const added = await storage.addSession(sessionOverrides({ turns }));
    await assert.rejects(
      () => storage.appendSessionTurn(added.id, { entryId: "entry-x", prompt: "one too many", resultFiles: ["/results/x.png"] }),
      /最多 20 轮/,
    );
  });
});

test("appendSessionTurn returns null for unknown sessions", async () => {
  await withStorage(async (storage) => {
    assert.equal(await storage.appendSessionTurn("nope", { resultFiles: [] }), null);
  });
});

test("removeSession deletes only the targeted session", async () => {
  await withStorage(async (storage) => {
    const first = await storage.addSession(sessionOverrides());
    const second = await storage.addSession(sessionOverrides({ title: "second" }));
    assert.equal(await storage.removeSession(first.id), true);
    assert.equal(await storage.getSession(first.id), null);
    const list = await storage.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, second.id);
    assert.equal(await storage.removeSession("nope"), false);
  });
});

test("enforces the 50-session limit", async () => {
  await withStorage(async (storage) => {
    for (let index = 0; index < 50; index += 1) {
      await storage.addSession(sessionOverrides({ title: `s-${index}` }));
    }
    await assert.rejects(() => storage.addSession(sessionOverrides({ title: "overflow" })), /上限/);
  });
});

test("session storage survives corrupt files via readJson fallback", async () => {
  await withStorage(async (storage, directory) => {
    await fs.writeFile(path.join(directory, "sessions.json"), "{not json");
    const list = await storage.listSessions();
    assert.deepEqual(list, []);
    const added = await storage.addSession(sessionOverrides());
    assert.ok(added.id);
  });
});

test("initialize creates the session-media directory and sessionMediaDir sanitizes segments", async () => {
  await withStorage(async (storage, directory) => {
    const stat = await fs.stat(path.join(directory, "session-media"));
    assert.ok(stat.isDirectory());
    const mediaDir = storage.sessionMediaDir("session-1");
    assert.ok(mediaDir.startsWith(path.join(directory, "session-media")));
    // Path traversal is neutralized by stripping non [a-zA-Z0-9_-] characters,
    // so "../escape" resolves inside the sandbox rather than escaping it.
    const sanitized = storage.sessionMediaDir("../escape");
    assert.equal(sanitized, path.join(directory, "session-media", "escape"));
    assert.throws(() => storage.sessionMediaDir(""), /无效的目录名称/);
  });
});

test("native reply files round-trip and reject poisoned names", async () => {
  await withStorage(async (storage, directory) => {
    const added = await storage.addSession(sessionOverrides());
    const reply = { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { thoughtSignature: "sig-1" }] };
    const fileName = await storage.writeSessionNativeReply(added.id, 1, reply);
    assert.equal(fileName, "turn-1.json");
    const stored = await storage.readSessionNativeReply(added.id, fileName);
    assert.deepEqual(stored, reply);

    // Missing or corrupt files read as null so replay can shrink its suffix.
    assert.equal(await storage.readSessionNativeReply(added.id, "turn-99.json"), null);
    await fs.writeFile(await Promise.resolve(path.join(storage.sessionNativeDir(added.id), "turn-2.json")), "{broken");
    assert.equal(await storage.readSessionNativeReply(added.id, "turn-2.json"), null);

    // Path traversal via a poisoned sessions.json entry never escapes the dir.
    assert.throws(() => storage.sessionNativeFilePath(added.id, "../escape.json"), /无效的原生回放文件名/);
    assert.throws(() => storage.sessionNativeFilePath(added.id, "../../evil.json"), /无效的原生回放文件名/);
    const resolved = storage.sessionNativeFilePath(added.id, "turn-1.json");
    assert.ok(resolved.startsWith(path.join(directory, "session-media", added.id, "native")));
  });
});

test("normalizeSessionTurn keeps nativeReplyFile on read-back", async () => {
  await withStorage(async (storage) => {
    const withReply = sessionOverrides({
      turns: [{ ...sessionOverrides().turns[0], nativeReplyFile: "turn-0.json" }],
    });
    const added = await storage.addSession(withReply);
    assert.equal(added.turns[0].nativeReplyFile, "turn-0.json");
    const reread = await storage.getSession(added.id);
    assert.equal(reread.turns[0].nativeReplyFile, "turn-0.json");
  });
});
