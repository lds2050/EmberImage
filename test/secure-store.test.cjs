"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { decryptSecret, decryptSecretForDevice, encryptSecret, encryptSecretForDevice, maskSecret } = require("../src/main/secure-store.cjs");

test("encrypts and decrypts an API key with a user password", () => {
  const secret = "sk-example-not-a-real-secret-1234";
  const encrypted = encryptSecret(secret, "correct horse battery staple");
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.equal(decryptSecret(encrypted, "correct horse battery staple"), secret);
});

test("fails safely for a wrong password", () => {
  const encrypted = encryptSecret("sk-example", "correct-password");
  assert.throws(() => decryptSecret(encrypted, "wrong-password"), /密码错误/);
});

test("requires a meaningful local encryption password", () => {
  assert.throws(() => encryptSecret("sk-example", "123"), /至少需要 6 个字符/);
});

test("encrypts a key for automatic local-device decryption", () => {
  const deviceKey = crypto.randomBytes(32);
  const secret = "sk-device-encrypted-example";
  const encrypted = encryptSecretForDevice(secret, deviceKey);
  assert.equal(encrypted.version, 2);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.equal(decryptSecretForDevice(encrypted, deviceKey), secret);
  assert.throws(() => decryptSecretForDevice(encrypted, crypto.randomBytes(32)), /设备密钥不匹配/);
});

test("masks secret values", () => {
  assert.equal(maskSecret("sk-example-123456789"), "sk-••••••••6789");
  assert.equal(maskSecret("short"), "••••••••");
});
