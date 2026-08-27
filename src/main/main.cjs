"use strict";

const { app, BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { AppStorage, DEFAULT_PROFILE } = require("./storage.cjs");
const { decryptSecret, decryptSecretForDevice, encryptSecretForDevice, maskSecret } = require("./secure-store.cjs");
const Validation = require("../shared/validation.js");

let mainWindow;
let storage;
let deviceEncryptionKey;
const sessionApiKeys = new Map();
const autoUnlockFailures = new Set();
const generationControllers = new Map();

// Keep the V0.1 data directory after the visible product rename so existing
// connections, encrypted keys, history, logs, and generated files migrate in place.
app.setPath("userData", path.join(app.getPath("appData"), "gpt-image-studio"));

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code || "app_error";
    this.status = options.status || null;
    this.requestId = options.requestId || null;
    this.detail = options.detail || "";
  }
}

function loadAppIcon() {
  try {
    const svg = fsSync.readFileSync(path.join(__dirname, "../assets/emberimage-icon.svg"), "utf8");
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  } catch {
    return nativeImage.createEmpty();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: "EmberImage",
    icon: loadAppIcon(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f6f4ef",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function publicProfile(profile) {
  const apiKey = sessionApiKeys.get(profile.id) || "";
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    keyStorage: profile.keyStorage,
    requestTimeoutSeconds: profile.requestTimeoutSeconds,
    streamEnabled: Boolean(profile.streamEnabled),
    hasSavedKey: Boolean(profile.encryptedKey),
    isUnlocked: Boolean(apiKey),
    needsLegacyUnlock: profile.encryptedKey?.version === 1,
    autoUnlockFailed: autoUnlockFailures.has(profile.id),
    maskedKey: maskSecret(apiKey),
  };
}

function publicConfig(config) {
  return {
    activeConnectionId: config.activeConnectionId,
    connections: config.connections.map(publicProfile),
  };
}

function getProfile(config, id = config.activeConnectionId) {
  const profile = config.connections.find((item) => item.id === id);
  if (!profile) throw new AppError("未找到连接配置", { code: "connection_not_found" });
  return profile;
}

function assertSecureBaseUrl(baseUrl) {
  const normalized = Validation.normalizeBaseUrl(baseUrl);
  const url = new URL(normalized);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (url.protocol !== "https:" && !localHosts.has(url.hostname)) {
    throw new AppError("非本机 API 地址必须使用 HTTPS", { code: "insecure_endpoint" });
  }
  return normalized;
}

function getRequestId(response) {
  return response.headers.get("x-request-id") || response.headers.get("request-id") || response.headers.get("cf-ray") || "";
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text.slice(0, 2000) }; }
}

function apiErrorFromResponse(response, body) {
  const apiError = body?.error || body || {};
  const message = apiError.message || `API 返回 HTTP ${response.status}`;
  let code = apiError.code || apiError.type || "api_error";
  if (response.status === 401) code = "authentication_error";
  if (response.status === 403) code = "permission_error";
  if (response.status === 429) code = "rate_limit_error";
  if (response.status >= 500) code = "server_error";
  return new AppError(message, {
    code,
    status: response.status,
    requestId: getRequestId(response),
    detail: typeof body === "string" ? body.slice(0, 16000) : JSON.stringify(body).slice(0, 16000),
  });
}

function presentError(error) {
  if (error?.name === "AbortError" || error?.code === "cancelled") {
    return { code: error?.code || "cancelled", message: error.message || "已取消本次生成" };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, status: error.status, requestId: error.requestId, detail: error.detail };
  }
  if (error?.details) return { code: "validation_error", message: error.message, fields: error.details };
  return { code: "unexpected_error", message: error?.message || "发生未知错误" };
}

function withResult(handler) {
  return async (_event, payload) => {
    try { return { ok: true, data: await handler(payload) }; }
    catch (error) { return { ok: false, error: presentError(error) }; }
  };
}

function logBase(profile, type, endpoint) {
  const url = new URL(endpoint);
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    connectionId: profile.id,
    connectionName: profile.name,
    type,
    method: type === "connection_test" ? "GET" : "POST",
    endpoint: `${url.origin}${url.pathname}`,
    model: profile.model,
  };
}

async function addLog(entry) {
  try { await storage.addLog(entry); }
  catch { /* Logging must never break generation. */ }
}

async function loadRuntimeConfig() {
  const config = await storage.loadConfig();
  for (const profile of config.connections) {
    if (!profile.encryptedKey || profile.encryptedKey.version !== 2 || sessionApiKeys.has(profile.id)) continue;
    try {
      sessionApiKeys.set(profile.id, decryptSecretForDevice(profile.encryptedKey, deviceEncryptionKey));
      autoUnlockFailures.delete(profile.id);
    } catch {
      autoUnlockFailures.add(profile.id);
    }
  }
  return config;
}

function requestDetails(profile, endpoint, method, body = null) {
  return {
    method,
    endpoint,
    headers: {
      Accept: body?.stream ? "text/event-stream" : "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer [已隐藏]",
    },
    timeoutSeconds: profile.requestTimeoutSeconds,
    body,
  };
}

async function loadConnections() {
  return publicConfig(await loadRuntimeConfig());
}

function validateTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) {
    throw new AppError("请求超时必须是 30 到 900 秒的整数", { code: "invalid_timeout" });
  }
  return timeout;
}

async function saveConnection(connection) {
  const config = await storage.loadConfig();
  const id = String(connection.id || crypto.randomUUID());
  const existing = config.connections.find((profile) => profile.id === id);
  const sessionKey = sessionApiKeys.get(id) || "";
  const apiKey = String(connection.apiKey || "").trim();
  const nextKey = apiKey || sessionKey;
  const requestedStorage = connection.keyStorage === "encrypted" ? "encrypted" : "session";
  const canReuseEncryptedKey = requestedStorage === "encrypted" && Boolean(existing?.encryptedKey);
  const result = Validation.validateConnection({ ...connection, apiKey: nextKey }, { requireKey: !nextKey && !canReuseEncryptedKey });
  if (!result.valid) {
    const error = new Error("连接配置校验失败");
    error.details = result.errors;
    throw error;
  }
  const name = String(connection.name || "").trim();
  if (!name) {
    const error = new Error("连接配置校验失败");
    error.details = { name: "请输入连接名称" };
    throw error;
  }

  const keyStorage = requestedStorage;
  let encryptedKey = existing?.encryptedKey || null;
  if (apiKey) sessionApiKeys.set(id, apiKey);
  if (keyStorage === "encrypted") {
    if (nextKey) encryptedKey = encryptSecretForDevice(nextKey, deviceEncryptionKey);
    if (!encryptedKey) throw new AppError("请输入要加密保存的 API Key", { code: "missing_api_key" });
  } else {
    encryptedKey = null;
  }

  const profile = {
    ...DEFAULT_PROFILE,
    ...(existing || {}),
    id,
    name,
    baseUrl: assertSecureBaseUrl(connection.baseUrl),
    model: String(connection.model).trim(),
    keyStorage,
    encryptedKey,
    requestTimeoutSeconds: validateTimeout(connection.requestTimeoutSeconds),
    streamEnabled: Boolean(connection.streamEnabled),
  };
  const index = config.connections.findIndex((item) => item.id === id);
  if (index >= 0) config.connections[index] = profile;
  else config.connections.push(profile);
  config.activeConnectionId = id;
  return publicConfig(await storage.saveConfig(config));
}

async function activateConnection(id) {
  const config = await storage.loadConfig();
  getProfile(config, String(id));
  config.activeConnectionId = String(id);
  return publicConfig(await storage.saveConfig(config));
}

async function deleteConnection(id) {
  const config = await storage.loadConfig();
  if (config.connections.length <= 1) throw new AppError("至少需要保留一份连接配置", { code: "last_connection" });
  const target = String(id);
  const next = config.connections.filter((profile) => profile.id !== target);
  if (next.length === config.connections.length) throw new AppError("未找到要删除的连接配置", { code: "connection_not_found" });
  sessionApiKeys.delete(target);
  config.connections = next;
  if (config.activeConnectionId === target) config.activeConnectionId = next[0].id;
  return publicConfig(await storage.saveConfig(config));
}

async function unlockConnection(payload) {
  const config = await storage.loadConfig();
  const profile = getProfile(config, String(payload.id));
  if (!profile.encryptedKey) throw new AppError("当前连接没有已加密保存的密钥", { code: "no_saved_key" });
  if (profile.encryptedKey.version !== 1) throw new AppError("当前连接应当自动解密，请重新填写 API Key", { code: "auto_unlock_failed" });
  const apiKey = decryptSecret(profile.encryptedKey, payload.password);
  sessionApiKeys.set(profile.id, apiKey);
  profile.encryptedKey = encryptSecretForDevice(apiKey, deviceEncryptionKey);
  autoUnlockFailures.delete(profile.id);
  return publicConfig(await storage.saveConfig(config));
}

async function testConnection(connection = {}) {
  const config = await loadRuntimeConfig();
  const saved = connection.id ? config.connections.find((item) => item.id === connection.id) : null;
  const profile = { ...DEFAULT_PROFILE, ...(saved || {}), ...connection, name: connection.name || saved?.name || "未保存连接" };
  if (connection.apiKey) sessionApiKeys.set(profile.id, String(connection.apiKey).trim());
  const baseUrl = assertSecureBaseUrl(profile.baseUrl);
  const apiKey = String(connection.apiKey || sessionApiKeys.get(profile.id) || "").trim();
  const validated = Validation.validateConnection({ ...profile, apiKey }, { requireKey: true });
  if (!validated.valid) {
    const error = new Error("连接配置校验失败");
    error.details = validated.errors;
    throw error;
  }

  const endpoint = Validation.modelsEndpoint(baseUrl);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(validateTimeout(profile.requestTimeoutSeconds), 60) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok && ![404, 405].includes(response.status)) throw apiErrorFromResponse(response, body);
    const models = Array.isArray(body.data) ? body.data.map((item) => item.id) : [];
    const modelVerified = models.includes(profile.model);
    const result = {
      connected: true,
      modelVerified,
      message: [404, 405].includes(response.status)
        ? "服务可以连接，但未提供模型列表接口；请通过实际生成验证模型能力"
        : modelVerified ? `连接成功，已检测到 ${profile.model}` : "连接成功，但模型列表中未检测到当前模型；兼容服务可能使用自定义模型名",
    };
    await addLog({ ...logBase(profile, "connection_test", endpoint), status: "success", httpStatus: response.status, durationMs: Date.now() - startedAt, requestId: getRequestId(response), request: requestDetails(profile, endpoint, "GET"), response: { modelVerified, modelCount: models.length } });
    return result;
  } catch (error) {
    const nextError = error.name === "AbortError" ? new AppError("连接测试超时", { code: "timeout" }) : error;
    await addLog({ ...logBase(profile, "connection_test", endpoint), status: "error", httpStatus: nextError.status || null, durationMs: Date.now() - startedAt, requestId: nextError.requestId || "", request: requestDetails(profile, endpoint, "GET"), responseBody: nextError.detail || null, errorCode: nextError.code || "network_error", errorMessage: nextError.message });
    throw nextError;
  } finally {
    clearTimeout(timeout);
  }
}

function detectImageFormat(bytes, fallback = "png") {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return fallback;
}

function mimeForFormat(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

async function downloadCompatibleImage(url, signal) {
  const target = new URL(url);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && localHosts.has(target.hostname))) throw new AppError("兼容接口返回了不安全的图片地址", { code: "unsafe_image_url" });
  const response = await fetch(target, { signal });
  if (!response.ok) throw apiErrorFromResponse(response, await readResponseBody(response));
  return Buffer.from(await response.arrayBuffer());
}

function safeTaskId(taskId) {
  const value = String(taskId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!value) throw new AppError("无效的任务编号", { code: "invalid_task" });
  return value.slice(0, 80);
}

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), "-", pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function hydrateEntry(entry) {
  return { ...entry, favorite: Boolean(entry.favorite), images: (entry.images || []).map((image) => ({ ...image, previewUrl: pathToFileURL(image.path).toString() })) };
}

function parseSseBlock(block) {
  let eventName = "";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length || dataLines.join("\n") === "[DONE]") return null;
  try {
    const data = JSON.parse(dataLines.join("\n"));
    return { eventName: eventName || data.type || "", data };
  } catch { return null; }
}

async function readStreamingImages(response, taskId, sender, outputFormat) {
  if (!response.body) throw new AppError("服务未返回可读取的流", { code: "invalid_stream" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const images = [];
  let usage = null;

  const processBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    const { eventName, data } = parsed;
    if (eventName.includes("partial_image") || data.type === "image_generation.partial_image") {
      const encoded = data.b64_json || data.partial_image_b64;
      if (encoded && !sender.isDestroyed()) sender.send("generation:partial", { taskId, index: data.partial_image_index || 0, previewUrl: `data:${mimeForFormat(outputFormat)};base64,${encoded}` });
    }
    if (eventName.includes("completed") || data.type === "image_generation.completed") {
      const encoded = data.b64_json || data.result;
      if (encoded) images.push({ b64_json: encoded });
      if (data.usage) usage = data.usage;
    }
    if (eventName.includes("error") || data.type === "error") throw new AppError(data.error?.message || data.message || "流式生成失败", { code: data.error?.code || "stream_error" });
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(processBlock);
    if (done) break;
  }
  if (buffer.trim()) processBlock(buffer);
  if (!images.length) throw new AppError("流式响应结束但没有最终图片", { code: "invalid_stream" });
  return { data: images, usage };
}

async function createGeneration(request, sender) {
  const taskId = safeTaskId(request.taskId);
  if (generationControllers.has(taskId)) throw new AppError("该任务已在生成中", { code: "duplicate_task" });
  const config = await loadRuntimeConfig();
  const profile = getProfile(config);
  const apiKey = sessionApiKeys.get(profile.id) || "";
  if (!apiKey) throw new AppError("请先输入 API Key，或完成旧版密钥迁移", { code: "missing_api_key" });

  const baseUrl = assertSecureBaseUrl(profile.baseUrl);
  const payload = Validation.buildGenerationPayload({ ...request.parameters, model: profile.model });
  const endpoint = Validation.generationEndpoint(baseUrl);
  const controllerRecord = { controller: new AbortController(), reason: "cancelled" };
  generationControllers.set(taskId, controllerRecord);
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    controllerRecord.reason = "timeout";
    controllerRecord.controller.abort();
  }, validateTimeout(profile.requestTimeoutSeconds) * 1000);
  let responseStatus = null;
  let requestId = "";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: payload.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(payload),
      signal: controllerRecord.controller.signal,
    });
    responseStatus = response.status;
    requestId = getRequestId(response);
    if (!response.ok) throw apiErrorFromResponse(response, await readResponseBody(response));
    const contentType = response.headers.get("content-type") || "";
    const body = payload.stream && contentType.includes("text/event-stream") ? await readStreamingImages(response, taskId, sender, payload.output_format) : await readResponseBody(response);
    if (!Array.isArray(body.data) || !body.data.length) throw new AppError("响应中没有可用的图片数据", { code: "invalid_response", requestId });

    const createdAt = new Date();
    const images = [];
    for (let index = 0; index < body.data.length; index += 1) {
      const item = body.data[index];
      let bytes;
      if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
      else if (item?.url) bytes = await downloadCompatibleImage(item.url, controllerRecord.controller.signal);
      else throw new AppError(`第 ${index + 1} 张结果缺少 b64_json 或 url`, { code: "invalid_response" });
      if (!bytes.length) throw new AppError("API 返回了空图片", { code: "decode_error" });
      const format = detectImageFormat(bytes, payload.output_format);
      const filename = `${timestampName(createdAt)}_${taskId.slice(-8)}_${index + 1}.${format === "jpeg" ? "jpg" : format}`;
      const filePath = await storage.writeResult(filename, bytes);
      images.push({ id: `${taskId}-${index}`, path: filePath, filename, format, mime: mimeForFormat(format), bytes: bytes.length });
    }

    const entry = {
      id: taskId,
      createdAt: createdAt.toISOString(),
      durationMs: Date.now() - startedAt,
      prompt: payload.prompt,
      model: payload.model,
      connectionId: profile.id,
      connectionName: profile.name,
      providerHost: new URL(baseUrl).host,
      favorite: false,
      parameters: { size: payload.size, quality: payload.quality, n: payload.n, background: payload.background, outputFormat: payload.output_format, outputCompression: payload.output_compression ?? null, moderation: payload.moderation, stream: payload.stream },
      requestId,
      usage: body.usage || null,
      images,
    };
    await storage.addHistory(entry);
    await addLog({ ...logBase(profile, "image_generation", endpoint), status: "success", httpStatus: responseStatus, durationMs: entry.durationMs, requestId, request: requestDetails(profile, endpoint, "POST", payload), response: { imageCount: images.length, usage: body.usage || null }, imageCount: images.length });
    return hydrateEntry(entry);
  } catch (error) {
    let nextError = error;
    if (error.name === "AbortError") {
      nextError = controllerRecord.reason === "timeout"
        ? new AppError(`请求超过 ${profile.requestTimeoutSeconds} 秒，已停止等待`, { code: "timeout" })
        : new AppError("已取消本次生成", { code: "cancelled" });
      nextError.name = "AbortError";
      nextError.code = controllerRecord.reason;
    }
    await addLog({ ...logBase(profile, "image_generation", endpoint), status: nextError.code === "cancelled" ? "cancelled" : "error", httpStatus: nextError.status || responseStatus, durationMs: Date.now() - startedAt, requestId: nextError.requestId || requestId, request: requestDetails(profile, endpoint, "POST", payload), responseBody: nextError.detail || null, errorCode: nextError.code || "network_error", errorMessage: nextError.message });
    throw nextError;
  } finally {
    clearTimeout(timeout);
    generationControllers.delete(taskId);
  }
}

function assertResultPath(filePath) {
  const root = path.resolve(storage.resultsDirectory);
  const target = path.resolve(String(filePath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new AppError("无效的结果文件路径", { code: "invalid_file" });
  return target;
}

async function uniqueDestination(directory, filename) {
  const parsed = path.parse(filename);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index}` : "";
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    try { await fs.access(candidate); }
    catch { return candidate; }
  }
  throw new AppError("无法创建不重名的下载文件", { code: "file_conflict" });
}

async function saveImage(image) {
  const source = assertResultPath(image.path);
  const result = await dialog.showSaveDialog(mainWindow, { title: "保存生成图片", defaultPath: path.join(app.getPath("downloads"), image.filename), filters: [{ name: "图片", extensions: [path.extname(image.filename).slice(1)] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.copyFile(source, result.filePath);
  return { canceled: false, filePath: result.filePath };
}

async function saveImages(images) {
  const result = await dialog.showOpenDialog(mainWindow, { title: "选择批量保存目录", defaultPath: app.getPath("downloads"), properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, files: [] };
  const files = [];
  for (const image of images) {
    const source = assertResultPath(image.path);
    const destination = await uniqueDestination(result.filePaths[0], image.filename);
    await fs.copyFile(source, destination);
    files.push(destination);
  }
  return { canceled: false, files };
}

async function copyImage(filePath) {
  const bytes = await fs.readFile(assertResultPath(filePath));
  if (!bytes.length) throw new AppError("无法读取要复制的图片", { code: "invalid_file" });
  const mime = mimeForFormat(detectImageFormat(bytes, path.extname(filePath).slice(1).replace("jpg", "jpeg")));
  await clipboard.write([new ClipboardItem({ [mime]: new Blob([bytes], { type: mime }) })]);
  return { copied: true };
}

async function deleteHistoryEntry(id) {
  const history = await storage.listHistory();
  const entry = history.find((item) => item.id === id);
  if (!entry) return { deleted: false };
  for (const image of entry.images || []) {
    try { await shell.trashItem(assertResultPath(image.path)); }
    catch { /* File may already be gone. */ }
  }
  await storage.removeHistory(id);
  return { deleted: true };
}

function registerIpcHandlers() {
  ipcMain.handle("connection:load", withResult(loadConnections));
  ipcMain.handle("connection:save", withResult(saveConnection));
  ipcMain.handle("connection:activate", withResult(activateConnection));
  ipcMain.handle("connection:delete", withResult(deleteConnection));
  ipcMain.handle("connection:unlock", withResult(unlockConnection));
  ipcMain.handle("connection:test", withResult(testConnection));
  ipcMain.handle("generation:create", async (event, payload) => {
    try { return { ok: true, data: await createGeneration(payload, event.sender) }; }
    catch (error) { return { ok: false, error: presentError(error) }; }
  });
  ipcMain.on("generation:cancel", (_event, taskId) => {
    const record = generationControllers.get(String(taskId));
    if (record) { record.reason = "cancelled"; record.controller.abort(); }
  });
  ipcMain.handle("history:list", withResult(async () => (await storage.listHistory()).map(hydrateEntry)));
  ipcMain.handle("history:favorite", withResult(async (payload) => {
    const entry = await storage.updateHistory(String(payload.id), { favorite: Boolean(payload.favorite) });
    return entry ? hydrateEntry(entry) : null;
  }));
  ipcMain.handle("history:delete", withResult(async (id) => deleteHistoryEntry(String(id))));
  ipcMain.handle("history:clear", withResult(async () => { await storage.clearHistory(); return { cleared: true }; }));
  ipcMain.handle("logs:list", withResult(async () => storage.listLogs()));
  ipcMain.handle("logs:clear", withResult(async () => { await storage.clearLogs(); return { cleared: true }; }));
  ipcMain.handle("image:save", withResult(saveImage));
  ipcMain.handle("image:save-many", withResult(saveImages));
  ipcMain.handle("image:copy", withResult(async (filePath) => copyImage(filePath)));
  ipcMain.handle("image:reveal", withResult(async (filePath) => { shell.showItemInFolder(assertResultPath(filePath)); return { revealed: true }; }));
  ipcMain.handle("app:info", withResult(async () => ({ version: app.getVersion(), platform: process.platform })));
}

app.whenReady().then(async () => {
  storage = new AppStorage(app.getPath("userData"));
  await storage.initialize();
  deviceEncryptionKey = await storage.getOrCreateDeviceKey();
  const icon = loadAppIcon();
  if (process.platform === "darwin" && !icon.isEmpty()) app.dock.setIcon(icon);
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
