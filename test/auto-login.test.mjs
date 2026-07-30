import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutoLoginService, loginWithPassword, solveCapChallenge } from "../src/auto-login.mjs";
import { DataStore } from "../src/storage.mjs";

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function prng(seed, length) {
  let state = fnv1a(seed);
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    result += state.toString(16).padStart(8, "0");
  }
  return result.slice(0, length);
}

function validSolutions(token, challenge, solutions) {
  return solutions.length === challenge.c && solutions.every((nonce, offset) => {
    const seed = `${token}${offset + 1}`;
    const target = prng(`${seed}d`, challenge.d);
    const salt = prng(seed, challenge.s);
    return createHash("sha256").update(`${salt}${nonce}`).digest("hex").startsWith(target);
  });
}

test("solves the go-cap seeded proof-of-work challenge", async () => {
  const token = "0123456789abcdef012345678";
  const challenge = { c: 4, s: 32, d: 2 };
  const solutions = await solveCapChallenge(token, challenge);
  assert.equal(validSolutions(token, challenge, solutions), true);
});

test("logs in through the CAPTCHA and password APIs without a browser", async () => {
  const token = "abcdef0123456789abcdef012";
  const challenge = { c: 3, s: 32, d: 2 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/challenge")) {
      return new Response(JSON.stringify({ token, challenge, expires: Date.now() + 120_000 }), { status: 201 });
    }
    if (pathname.endsWith("/redeem")) {
      const body = JSON.parse(options.body);
      assert.equal(body.token, token);
      assert.equal(validSolutions(token, challenge, body.solutions), true);
      return new Response(JSON.stringify({ success: true, token: "12345678:verification" }), { status: 201 });
    }
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      email: "account@example.com",
      password: "private-password",
      captcha_token: "12345678:verification",
    });
    return new Response(JSON.stringify({ code: 0, data: { id: "user-1" } }), {
      status: 200,
      headers: { "Set-Cookie": "monkeycode_ai_session=fresh-session; Max-Age=7200; Path=/; HttpOnly; Secure" },
    });
  };

  const before = Date.now();
  const result = await loginWithPassword({
    baseUrl: new URL("https://monkeycode-ai.com"),
    email: "account@example.com",
    password: "private-password",
    fetchImpl,
  });

  assert.deepEqual(requests, [
    "/api/v1/public/captcha/challenge",
    "/api/v1/public/captcha/redeem",
    "/api/v1/users/password-login",
  ]);
  assert.equal(result.session, "fresh-session");
  assert.ok(new Date(result.expiresAt).getTime() >= before + 7_199_000);
});

test("encrypts login credentials and renews a missing session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-auto-login-"));
  try {
    const store = await new DataStore(directory, randomBytes(32)).init();
    const account = await store.upsertAccount({
      name: "Automatic account",
      baseUrl: "https://monkeycode-ai.com",
      loginEmail: "account@example.com",
      loginPassword: "private-password",
      autoLoginEnabled: true,
    });
    const notifications = [];
    const service = new AutoLoginService(store, {
      notify: async (event, context) => notifications.push({ event, context }),
    }, {
      login: async () => ({ session: "renewed-session", expiresAt: "2026-08-30T00:00:00.000Z" }),
      checkSession: async () => ({ id: "user-1", name: "Remote user" }),
    });

    assert.equal(service.needsRenewal(account), true);
    const result = await service.renewIfNeeded(account, { trigger: "test" });
    assert.equal(result.renewed, true);
    assert.equal(result.account.sessionConfigured, true);
    assert.equal(result.account.lastAutoLoginStatus, "valid");
    assert.equal(store.getAccount(account.id, { withSession: true }).session, "renewed-session");
    assert.deepEqual(store.getAccount(account.id, { withLogin: true }).login, {
      email: "account@example.com",
      password: "private-password",
    });
    assert.equal(notifications.length, 0);

    const publicAccount = store.getAccount(account.id);
    assert.equal("loginEncrypted" in publicAccount, false);
    assert.equal("login" in publicAccount, false);
    const config = await readFile(path.join(directory, "config.json"), "utf8");
    assert.equal(config.includes("account@example.com"), false);
    assert.equal(config.includes("private-password"), false);
    assert.equal(config.includes("renewed-session"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backs off after a failed automatic login", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-auto-login-failure-"));
  try {
    const store = await new DataStore(directory, randomBytes(32)).init();
    const account = await store.upsertAccount({
      name: "Failed account",
      baseUrl: "https://monkeycode-ai.com",
      loginEmail: "account@example.com",
      loginPassword: "wrong-password",
      autoLoginEnabled: true,
    });
    const notifications = [];
    const service = new AutoLoginService(store, {
      notify: async (event, context) => notifications.push({ event, context }),
    }, {
      login: async () => { throw new Error("saved credentials were rejected"); },
    });
    const now = new Date("2026-07-30T12:00:00.000Z");

    await assert.rejects(service.renewIfNeeded(account, { now, trigger: "test" }), /saved credentials were rejected/);
    const failed = store.getAccount(account.id);
    assert.equal(failed.lastAutoLoginStatus, "failed");
    assert.equal(failed.autoLoginFailureCount, 1);
    assert.equal(failed.autoLoginNextAttemptAt, "2026-07-30T12:15:00.000Z");
    assert.equal(service.needsRenewal(failed, now), false);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].event, "auth-expired");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
