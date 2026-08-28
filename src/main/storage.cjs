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
};

const DEFAULT_CONFIG = {
  version: 2,
  activeConnectionId: DEFAULT_PROFILE.id,
  connections: [{ ...DEFAULT_PROFILE }],
  downloadDirectory: "",
};

class AppStorage {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.configPath = path.join(rootDirectory, "config.json");
    this.historyPath = path.join(rootDirectory, "history.json");
    this.logsPath = path.join(rootDirectory, "request-logs.json");
    this.deviceKeyPath = path.join(rootDirectory, "device-encryption.key");
    this.resultsDirectory = path.join(rootDirectory, "results");
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

  async listHistory() {
    const history = await this.readJson(this.historyPath, []);
    return Array.isArray(history) ? history : [];
  }

  async addHistory(entry) {
    return this.runExclusive(this.historyPath, async () => {
      const history = await this.listHistory();
      history.unshift(entry);
      await this.writeJson(this.historyPath, history.slice(0, 200));
      return entry;
    });
  }

  async removeHistory(id) {
    return this.runExclusive(this.historyPath, async () => {
      const history = await this.listHistory();
      const next = history.filter((entry) => entry.id !== id);
      await this.writeJson(this.historyPath, next);
      return history.length !== next.length;
    });
  }

  async clearHistory() {
    return this.runExclusive(this.historyPath, () => this.writeJson(this.historyPath, []));
  }

  async updateHistory(id, changes) {
    return this.runExclusive(this.historyPath, async () => {
      const history = await this.listHistory();
      const index = history.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      history[index] = { ...history[index], ...changes };
      await this.writeJson(this.historyPath, history);
      return history[index];
    });
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
