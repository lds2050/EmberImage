"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

const DEFAULT_PROFILE = {
  id: "openai-default",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-image-2",
  keyStorage: "session",
  encryptedKey: null,
  requestTimeoutSeconds: 180,
  streamEnabled: false,
  generationCapability: "unknown",
  editCapability: "unknown",
};

const DEFAULT_CONFIG = {
  version: 2,
  activeConnectionId: DEFAULT_PROFILE.id,
  connections: [{ ...DEFAULT_PROFILE }],
  downloadDirectory: "",
};

const HISTORY_VERSION = 3;
const HISTORY_LIMIT = 200;

const PROMPTS_VERSION = 1;
const PROMPTS_LIMIT = 500;
const PROMPT_TEXT_LIMIT = 32000;
const PROMPT_CATEGORY_LIMIT = 24;
const PROMPT_DEFAULT_CATEGORY = "未分类";

function normalizePromptEntry(entry) {
  const item = entry && typeof entry === "object" ? entry : {};
  const text = typeof item.text === "string" ? item.text.trim().slice(0, PROMPT_TEXT_LIMIT) : "";
  const category = typeof item.category === "string" ? item.category.trim().slice(0, PROMPT_CATEGORY_LIMIT) : "";
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    text,
    category: category || PROMPT_DEFAULT_CATEGORY,
    createdAt: typeof item.createdAt === "string" && item.createdAt ? item.createdAt : null,
    updatedAt: typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : null,
    sourceHistoryId: typeof item.sourceHistoryId === "string" && item.sourceHistoryId ? item.sourceHistoryId : null,
  };
}

function normalizeHistoryEntry(entry) {
  const item = entry && typeof entry === "object" ? entry : {};
  return {
    operation: "generate",
    editMode: "",
    inputs: [],
    mask: null,
    ...item,
  };
}

class AppStorage {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.configPath = path.join(rootDirectory, "config.json");
    this.historyPath = path.join(rootDirectory, "history.json");
    this.promptsPath = path.join(rootDirectory, "prompts.json");
    this.logsPath = path.join(rootDirectory, "request-logs.json");
    this.deviceKeyPath = path.join(rootDirectory, "device-encryption.key");
    this.resultsDirectory = path.join(rootDirectory, "results");
    this.historyMediaDirectory = path.join(rootDirectory, "history-media");
    this.tmpDirectory = path.join(rootDirectory, "tmp");
    this.thumbsDirectory = path.join(rootDirectory, "thumbs");
    this.fileQueues = new Map();
  }

  runExclusive(filePath, operation) {
    const previous = this.fileQueues.get(filePath) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const chain = result.catch(() => {});
    this.fileQueues.set(filePath, chain);
    chain.then(() => {
      if (this.fileQueues.get(filePath) === chain) this.fileQueues.delete(filePath);
    });
    return result;
  }

  async initialize() {
    await fs.mkdir(this.resultsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.historyMediaDirectory, { recursive: true, mode: 0o700 });
    await this.resetEphemeralDirectories();
    await this.migrateHistory();
  }

  async resetEphemeralDirectories() {
    // tmp/thumbs 只被内存中的素材注册表和进行中的请求引用，重启后残留即孤儿，启动时清空。
    for (const directory of [this.tmpDirectory, this.thumbsDirectory]) {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }

  _safeSegment(value) {
    const segment = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!segment) throw new Error("无效的目录名称");
    return segment.slice(0, 80);
  }

  async migrateHistory() {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(this.historyPath, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    const entries = raw.map((entry) => normalizeHistoryEntry(entry)).slice(0, HISTORY_LIMIT);
    await this.runExclusive(this.historyPath, () => this.writeJson(this.historyPath, { version: HISTORY_VERSION, entries }));
  }

  async readJson(filePath, fallback) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
  }

  async writeJson(filePath, value) {
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  }

  async getOrCreateDeviceKey() {
    return this.runExclusive(this.deviceKeyPath, async () => {
      try {
        const encoded = (await fs.readFile(this.deviceKeyPath, "utf8")).trim();
        const key = Buffer.from(encoded, "base64");
        if (key.length !== 32) throw new Error("本机加密设备密钥格式无效");
        return key;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const key = crypto.randomBytes(32);
        const temporaryPath = `${this.deviceKeyPath}.tmp`;
        await fs.writeFile(temporaryPath, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporaryPath, this.deviceKeyPath);
        return key;
      }
    });
  }

  async loadConfig() {
    const stored = await this.readJson(this.configPath, {});
    if (stored.version === 2 && Array.isArray(stored.connections) && stored.connections.length) {
      const connections = stored.connections.map((profile) => ({ ...DEFAULT_PROFILE, ...profile }));
      const activeConnectionId = connections.some((profile) => profile.id === stored.activeConnectionId)
        ? stored.activeConnectionId
        : connections[0].id;
      return { ...DEFAULT_CONFIG, ...stored, connections, activeConnectionId };
    }

    if (stored.baseUrl || stored.model || stored.encryptedKey) {
      const migrated = {
        ...DEFAULT_PROFILE,
        baseUrl: stored.baseUrl || DEFAULT_PROFILE.baseUrl,
        model: stored.model || DEFAULT_PROFILE.model,
        keyStorage: stored.keyStorage || DEFAULT_PROFILE.keyStorage,
        encryptedKey: stored.encryptedKey || null,
      };
      const config = {
        ...DEFAULT_CONFIG,
        downloadDirectory: stored.downloadDirectory || "",
        connections: [migrated],
      };
      await this.runExclusive(this.configPath, () => this.writeJson(this.configPath, config));
      return config;
    }

    return {
      ...DEFAULT_CONFIG,
      connections: DEFAULT_CONFIG.connections.map((profile) => ({ ...profile })),
    };
  }

  async saveConfig(config) {
    const next = {
      ...DEFAULT_CONFIG,
      ...config,
      version: 2,
      connections: config.connections.map((profile) => ({ ...DEFAULT_PROFILE, ...profile })),
    };
    await this.runExclusive(this.configPath, () => this.writeJson(this.configPath, next));
    return next;
  }

  async _readHistoryEntries() {
    const stored = await this.readJson(this.historyPath, null);
    let entries;
    if (Array.isArray(stored)) entries = stored;
    else if (stored && Array.isArray(stored.entries)) entries = stored.entries;
    else entries = [];
    return entries.map((entry) => normalizeHistoryEntry(entry));
  }

  async listHistory() {
    return this._readHistoryEntries();
  }

  async addHistory(entry) {
    return this.runExclusive(this.historyPath, async () => {
      const entries = await this._readHistoryEntries();
      entries.unshift(normalizeHistoryEntry(entry));
      await this.writeJson(this.historyPath, { version: HISTORY_VERSION, entries: entries.slice(0, HISTORY_LIMIT) });
      return entry;
    });
  }

  async removeHistory(id) {
    return this.runExclusive(this.historyPath, async () => {
      const entries = await this._readHistoryEntries();
      const next = entries.filter((entry) => entry.id !== id);
      await this.writeJson(this.historyPath, { version: HISTORY_VERSION, entries: next });
      return entries.length !== next.length;
    });
  }

  async clearHistory() {
    return this.runExclusive(this.historyPath, () => this.writeJson(this.historyPath, { version: HISTORY_VERSION, entries: [] }));
  }

  async updateHistory(id, changes) {
    return this.runExclusive(this.historyPath, async () => {
      const entries = await this._readHistoryEntries();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      entries[index] = { ...entries[index], ...changes };
      await this.writeJson(this.historyPath, { version: HISTORY_VERSION, entries });
      return entries[index];
    });
  }

  async listPrompts() {
    const stored = await this.readJson(this.promptsPath, null);
    const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
    return entries.map((entry) => normalizePromptEntry(entry));
  }

  async addPrompt(entry) {
    return this.runExclusive(this.promptsPath, async () => {
      const stored = await this.readJson(this.promptsPath, null);
      const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
      if (entries.length >= PROMPTS_LIMIT) throw new Error("提示词库已满（500 条），请先清理");
      const normalized = normalizePromptEntry(entry);
      if (!normalized.text) throw new Error("提示词正文不能为空");
      const now = new Date().toISOString();
      normalized.createdAt = normalized.createdAt || now;
      normalized.updatedAt = now;
      entries.unshift(normalized);
      await this.writeJson(this.promptsPath, { version: PROMPTS_VERSION, entries });
      return normalized;
    });
  }

  async updatePrompt(id, changes) {
    return this.runExclusive(this.promptsPath, async () => {
      const stored = await this.readJson(this.promptsPath, null);
      const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const patch = changes && typeof changes === "object" ? changes : {};
      const merged = normalizePromptEntry({ ...entries[index], ...patch, id: entries[index].id });
      if (!merged.text) throw new Error("提示词正文不能为空");
      merged.createdAt = entries[index].createdAt;
      merged.updatedAt = new Date().toISOString();
      entries[index] = merged;
      await this.writeJson(this.promptsPath, { version: PROMPTS_VERSION, entries });
      return merged;
    });
  }

  async removePrompt(id) {
    return this.runExclusive(this.promptsPath, async () => {
      const stored = await this.readJson(this.promptsPath, null);
      const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
      const next = entries.filter((entry) => entry.id !== id);
      await this.writeJson(this.promptsPath, { version: PROMPTS_VERSION, entries: next });
      return next.length !== entries.length;
    });
  }

  async createTaskTempDir(taskId) {
    const dir = path.join(this.tmpDirectory, this._safeSegment(taskId));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async cleanTaskTempDir(taskId) {
    const dir = path.join(this.tmpDirectory, this._safeSegment(taskId));
    await fs.rm(dir, { recursive: true, force: true });
  }

  async promoteTaskMedia(taskId, entryId) {
    const source = path.join(this.tmpDirectory, this._safeSegment(taskId));
    const destination = path.join(this.historyMediaDirectory, this._safeSegment(entryId));
    await fs.mkdir(this.historyMediaDirectory, { recursive: true, mode: 0o700 });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(source, destination);
    return destination;
  }

  async writeThumbnail(filename, bytes) {
    const filePath = path.join(this.thumbsDirectory, this._safeSegment(filename));
    await fs.writeFile(filePath, bytes, { mode: 0o600 });
    return filePath;
  }

  assertAllowedPath(filePath, root) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(String(filePath));
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("无效的文件路径");
    }
    return target;
  }

  async listLogs() {
    const logs = await this.readJson(this.logsPath, []);
    return Array.isArray(logs) ? logs : [];
  }

  async addLog(entry) {
    return this.runExclusive(this.logsPath, async () => {
      const logs = await this.listLogs();
      logs.unshift(entry);
      await this.writeJson(this.logsPath, logs.slice(0, 500));
      return entry;
    });
  }

  async clearLogs() {
    return this.runExclusive(this.logsPath, () => this.writeJson(this.logsPath, []));
  }

  async writeResult(filename, bytes) {
    const filePath = path.join(this.resultsDirectory, filename);
    return this.runExclusive(filePath, async () => {
      const temporaryPath = `${filePath}.tmp`;
      await fs.writeFile(temporaryPath, bytes, { mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
      return filePath;
    });
  }
}

module.exports = { AppStorage, DEFAULT_CONFIG, DEFAULT_PROFILE };
