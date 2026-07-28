import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { ConfigError } from "./errors.mjs";

export function parseMasterKey(value) {
  if (!value) {
    throw new ConfigError("MONKEYCODE_MASTER_KEY is required for the control panel");
  }

  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new ConfigError("MONKEYCODE_MASTER_KEY must be 32 bytes encoded as base64 or 64 hex characters");
  }
  return key;
}

export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

export function decryptJson(payload, key) {
  if (!payload || payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) {
    throw new ConfigError("Encrypted configuration value is invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new ConfigError("Cannot decrypt configuration; verify MONKEYCODE_MASTER_KEY");
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyPassword(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function createToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
