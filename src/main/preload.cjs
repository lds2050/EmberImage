"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("imageStudio", {
  loadConfig: () => ipcRenderer.invoke("connection:load"),
  saveConnection: (connection) => ipcRenderer.invoke("connection:save", connection),
  activateConnection: (id) => ipcRenderer.invoke("connection:activate", id),
  deleteConnection: (id) => ipcRenderer.invoke("connection:delete", id),
  unlockConnection: (id, password) => ipcRenderer.invoke("connection:unlock", { id, password }),
  testConnection: (connection) => ipcRenderer.invoke("connection:test", connection),
  generate: (request) => ipcRenderer.invoke("generation:create", request),
  cancelGeneration: (taskId) => ipcRenderer.send("generation:cancel", taskId),
  onGenerationPartial: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("generation:partial", listener);
    return () => ipcRenderer.removeListener("generation:partial", listener);
  },
  listHistory: () => ipcRenderer.invoke("history:list"),
  favoriteHistory: (id, favorite) => ipcRenderer.invoke("history:favorite", { id, favorite }),
  deleteHistory: (id) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  listLogs: () => ipcRenderer.invoke("logs:list"),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  saveImage: (image) => ipcRenderer.invoke("image:save", image),
  saveImages: (images) => ipcRenderer.invoke("image:save-many", images),
  copyImage: (filePath) => ipcRenderer.invoke("image:copy", filePath),
  copyText: (value) => ipcRenderer.invoke("clipboard:write-text", value),
  revealImage: (filePath) => ipcRenderer.invoke("image:reveal", filePath),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
});
