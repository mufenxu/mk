import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserBridgeService } from "../src/browser-bridge.mjs";
import { NotificationService } from "../src/notifications.mjs";
import { TaskRunner } from "../src/runner.mjs";
import { PanelServer } from "../src/server.mjs";
import { DataStore } from "../src/storage.mjs";

const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function createFixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-bridge-"));
  const store = await new DataStore(directory, randomBytes(32)).init();
  const account = await store.upsertAccount({ name: "Remote account", baseUrl: "https://monkeycode-ai.com" });
  let now = Date.parse("2026-07-27T01:00:00.000Z");
  const service = new BrowserBridgeService(store, {
    now: () => now,
    checkSession: options.checkSession ?? (async ({ session }) => ({
      id: session === "other-cookie" ? "user-2" : "user-1",
      name: session === "other-cookie" ? "Other user" : "Expected user",
    })),
  });
  return {
    directory,
    store,
    account,
    service,
    advance(milliseconds = 2_000) { now += milliseconds; },
  };
}

test("browser bridge stores only a token hash and locks synchronized cookies to one user", async () => {
  const fixture = await createFixture();
  try {
    const generated = fixture.service.generatePairCode(fixture.account.id);
    const paired = await fixture.service.pair({
      code: generated.code,
      deviceId: "profile-device-01",
      deviceName: "Windows / Chrome",
    }, { origin: extensionOrigin, address: "127.0.0.1" });

    assert.ok(paired.token.length >= 32);
    await assert.rejects(
      fixture.service.pair({ code: generated.code, deviceId: "profile-device-02", deviceName: "Second Chrome" }, { origin: extensionOrigin, address: "127.0.0.1" }),
      (error) => error.code === "invalid-pairing-code",
    );

    fixture.advance();
    const synchronized = await fixture.service.sync({
      session: "expected-cookie",
      expiresAt: "2026-08-03T01:00:00.000Z",
    }, { origin: extensionOrigin, authorization: `Bearer ${paired.token}` });
    assert.equal(synchronized.account.userId, "user-1");
    assert.equal(synchronized.account.sessionSource, "chrome-extension");
    assert.equal(fixture.store.getAccount(fixture.account.id, { withSession: true }).session, "expected-cookie");

    const disk = await readFile(path.join(fixture.directory, "config.json"), "utf8");
    assert.equal(disk.includes(paired.token), false);
    assert.equal(disk.includes("expected-cookie"), false);
    assert.match(JSON.parse(disk).browserBridges[0].tokenHash, /^[0-9a-f]{64}$/);

    fixture.advance();
    await assert.rejects(
      fixture.service.sync({ session: "other-cookie", expiresAt: "2026-08-03T01:00:00.000Z" }, { origin: extensionOrigin, authorization: `Bearer ${paired.token}` }),
      (error) => error.status === 409 && error.code === "account-mismatch",
    );
    assert.equal(fixture.store.getAccount(fixture.account.id, { withSession: true }).session, "expected-cookie");

    await assert.rejects(
      fixture.service.status({ origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", authorization: `Bearer ${paired.token}` }),
      (error) => error.code === "invalid-bridge-token",
    );

    const secondAccount = await fixture.store.upsertAccount({ name: "Second account", baseUrl: "https://monkeycode-ai.com" });
    const secondCode = fixture.service.generatePairCode(secondAccount.id);
    const replacement = await fixture.service.pair({
      code: secondCode.code,
      deviceId: "profile-device-01",
      deviceName: "Windows / Chrome",
    }, { origin: extensionOrigin, address: "127.0.0.1" });
    await assert.rejects(
      fixture.service.status({ origin: extensionOrigin, authorization: `Bearer ${paired.token}` }),
      (error) => error.code === "invalid-bridge-token",
    );
    assert.equal((await fixture.service.status({ origin: extensionOrigin, authorization: `Bearer ${replacement.token}` })).account.id, secondAccount.id);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("browser bridge HTTP endpoints require an exact Chrome extension origin", async () => {
  const fixture = await createFixture();
  const notifications = new NotificationService(fixture.store);
  const runner = new TaskRunner(fixture.store, notifications);
  const panel = new PanelServer({
    store: fixture.store,
    notifications,
    runner,
    browserBridge: fixture.service,
    password: "correct horse battery staple",
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
  });
  const address = await panel.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    const auth = await login.json();
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const generated = await fetch(`${baseUrl}/api/browser-bridge/pair-code`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf },
      body: JSON.stringify({ accountId: fixture.account.id }),
    });
    assert.equal(generated.status, 201);
    const pairCode = await generated.json();

    const preflight = await fetch(`${baseUrl}/api/browser-bridge/pair`, {
      method: "OPTIONS",
      headers: { Origin: extensionOrigin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

    const noOrigin = await fetch(`${baseUrl}/api/browser-bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairCode.code, deviceId: "profile-device-01", deviceName: "Chrome" }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);

    const paired = await fetch(`${baseUrl}/api/browser-bridge/pair`, {
      method: "POST",
      headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairCode.code, deviceId: "profile-device-01", deviceName: "Chrome" }),
    });
    assert.equal(paired.status, 201);
    assert.equal(paired.headers.get("access-control-allow-origin"), extensionOrigin);
    assert.ok((await paired.json()).token);
  } finally {
    await panel.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
