"use strict";

const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LENGTH);
}

function encryptSecret(secret, password) {
  if (!secret) throw new Error("没有可保存的密钥");
  if (!password || String(password).length < 6) {
    throw new Error("本地加密密码至少需要 6 个字符");
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(password, salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(secret), "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    algorithm: ALGORITHM,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptSecret(record, password) {
  if (!record || record.version !== 1 || record.algorithm !== ALGORITHM) {
    throw new Error("不支持的密钥存储格式");
  }
  if (!password) throw new Error("请输入本地加密密码");

  try {
    const salt = Buffer.from(record.salt, "base64");
    const iv = Buffer.from(record.iv, "base64");
    const authTag = Buffer.from(record.authTag, "base64");
    const encrypted = Buffer.from(record.ciphertext, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(password, salt), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("本地加密密码错误，或密钥数据已损坏");
  }
}

function normalizeDeviceKey(deviceKey) {
  const key = Buffer.isBuffer(deviceKey) ? deviceKey : Buffer.from(deviceKey || "", "base64");
  if (key.length !== KEY_LENGTH) throw new Error("本机加密设备密钥无效");
  return key;
}

function encryptSecretForDevice(secret, deviceKey) {
  if (!secret) throw new Error("没有可保存的密钥");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, normalizeDeviceKey(deviceKey), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return {
    version: 2,
    algorithm: ALGORITHM,
    keySource: "local-device-file",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptSecretForDevice(record, deviceKey) {
  if (!record || record.version !== 2 || record.algorithm !== ALGORITHM) {
    throw new Error("不支持的本机密钥存储格式");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, normalizeDeviceKey(deviceKey), Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("本机加密数据已损坏或设备密钥不匹配");
  }
}

function maskSecret(secret) {
  if (!secret) return "";
  const value = String(secret);
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}••••••••${value.slice(-4)}`;
}

module.exports = { decryptSecret, decryptSecretForDevice, encryptSecret, encryptSecretForDevice, maskSecret };
