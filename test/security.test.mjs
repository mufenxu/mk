import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { ConfigError } from "../src/errors.mjs";
import { decryptJson, encryptJson, parseMasterKey, verifyPassword } from "../src/security.mjs";

test("encrypts and authenticates configuration secrets", () => {
  const key = randomBytes(32);
  const encrypted = encryptJson({ session: "private-cookie" }, key);
  assert.equal(JSON.stringify(encrypted).includes("private-cookie"), false);
  assert.deepEqual(decryptJson(encrypted, key), { session: "private-cookie" });
  assert.throws(() => decryptJson(encrypted, randomBytes(32)), ConfigError);
});

test("accepts base64 and hex 32-byte master keys", () => {
  const key = randomBytes(32);
  assert.deepEqual(parseMasterKey(key.toString("base64")), key);
  assert.deepEqual(parseMasterKey(key.toString("hex")), key);
  assert.throws(() => parseMasterKey("too-short"), ConfigError);
});

test("compares panel passwords without direct string equality", () => {
  assert.equal(verifyPassword("correct horse battery staple", "correct horse battery staple"), true);
  assert.equal(verifyPassword("wrong", "correct horse battery staple"), false);
});
