import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NotificationService } from "../src/notifications.mjs";
import { TaskRunner } from "../src/runner.mjs";
import { PanelServer } from "../src/server.mjs";
import { encryptJson } from "../src/security.mjs";
import { DataStore } from "../src/storage.mjs";

const monkeyTaskId = "678fed52-b2a8-467f-a94c-3b0fde6f1c89";

function taskPayload() {
  return {
    name: "Daily project report",
    monkeyTaskId,
    baseUrl: "https://monkeycode-ai.com",
    session: "private-session-cookie",
    enabled: true,
    keepAwake: true,
    dryRun: true,
    dedupe: true,
    prompt: "Report for {{date}}",
    schedule: {
      mode: "weekdays",
      time: "09:00",
      timeZone: "Asia/Shanghai",
      weekdays: [1, 2, 3, 4, 5],
      catchUp: true,
      includeDates: [],
      excludeDates: [],
    },
    retry: { attempts: 3, delaySeconds: 0 },
  };
}

test("panel auth and task APIs keep the MonkeyCode cookie encrypted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-"));
  const store = await new DataStore(directory, randomBytes(32)).init();
  const notifications = new NotificationService(store);
  const runner = new TaskRunner(store, notifications);
  const remoteSync = {
    syncAll: async () => [{ accountId: "test", ok: true }],
    syncAccount: async (id) => ({ ...store.getAccount(id), remoteSyncStatus: "synced" }),
    taskDetail: async (_accountId, id) => ({ id, name: "Remote task", status: "processing" }),
    configure: () => {},
  };
  const renewals = [];
  const autoLogin = {
    renewAccount: async (id, options) => {
      renewals.push({ id, options });
      return store.getAccount(id);
    },
  };
  const panel = new PanelServer({
    store,
    notifications,
    runner,
    password: "correct horse battery staple",
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
    remoteSync,
    autoLogin,
  });
  const address = await panel.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const anonymous = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await anonymous.json(), { authenticated: false });

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    assert.equal(auth.authenticated, true);

    const rejected = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(taskPayload()),
    });
    assert.equal(rejected.status, 403);

    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf },
      body: JSON.stringify(taskPayload()),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.task.sessionConfigured, true);
    assert.ok(createdBody.task.accountId);
    assert.equal("session" in createdBody.task, false);
    assert.equal("sessionEncrypted" in createdBody.task, false);

    const tasks = await fetch(`${baseUrl}/api/tasks`, { headers: { Cookie: cookie } });
    const taskBody = await tasks.json();
    assert.equal(taskBody.tasks[0].sessionConfigured, true);
    assert.equal(JSON.stringify(taskBody).includes("private-session-cookie"), false);

    const accounts = await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: cookie } });
    const accountBody = await accounts.json();
    assert.equal(accountBody.accounts.length, 1);
    assert.equal(accountBody.accounts[0].sessionConfigured, true);
    assert.equal(accountBody.accounts[0].taskCount, 1);
    assert.equal("session" in accountBody.accounts[0], false);
    assert.equal("sessionEncrypted" in accountBody.accounts[0], false);

    const renewed = await fetch(`${baseUrl}/api/accounts/${createdBody.task.accountId}/renew-session`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": auth.csrf },
    });
    assert.equal(renewed.status, 200);
    assert.deepEqual(renewals, [{ id: createdBody.task.accountId, options: { trigger: "manual" } }]);

    const syncRejected = await fetch(`${baseUrl}/api/accounts/${createdBody.task.accountId}/sync-remote`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(syncRejected.status, 403);
    const synced = await fetch(`${baseUrl}/api/accounts/${createdBody.task.accountId}/sync-remote`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": auth.csrf },
    });
    assert.equal(synced.status, 200);
    assert.equal((await synced.json()).account.remoteSyncStatus, "synced");
    const remoteDetail = await fetch(`${baseUrl}/api/accounts/${createdBody.task.accountId}/remote-tasks/${monkeyTaskId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(remoteDetail.status, 200);
    assert.equal((await remoteDetail.json()).task.id, monkeyTaskId);

    const protectedDelete = await fetch(`${baseUrl}/api/accounts/${createdBody.task.accountId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": auth.csrf },
    });
    assert.equal(protectedDelete.status, 400);

    const configOnDisk = await readFile(path.join(directory, "config.json"), "utf8");
    assert.equal(configOnDisk.includes("private-session-cookie"), false);
    assert.equal(configOnDisk.includes("sessionEncrypted"), true);
    const parsedConfig = JSON.parse(configOnDisk);
    assert.equal(parsedConfig.version, 10);
    assert.equal(parsedConfig.tasks[0].keepAwake, true);
    assert.deepEqual(parsedConfig.tasks[0].schedule.times, ["09:00"]);
    assert.equal(parsedConfig.tasks[0].completion.enabled, true);
    assert.equal(parsedConfig.accounts.length, 1);
    assert.equal("sessionEncrypted" in parsedConfig.tasks[0], false);
    assert.equal("baseUrl" in parsedConfig.tasks[0], false);
    const backupFiles = await readdir(path.join(directory, "backups"));
    assert.equal(backupFiles.length, 1);
    const backup = JSON.parse(await readFile(path.join(directory, "backups", backupFiles[0]), "utf8"));
    assert.deepEqual(backup.tasks, []);

    const backupList = await fetch(`${baseUrl}/api/backups`, { headers: { Cookie: cookie } });
    assert.equal(backupList.status, 200);
    const listedBackups = (await backupList.json()).backups;
    assert.equal(listedBackups.length, 1);
    assert.equal(listedBackups[0].valid, true);
    assert.deepEqual(listedBackups[0].counts, { accounts: 0, tasks: 0, notifications: 0 });

    const preview = await fetch(`${baseUrl}/api/backups/${listedBackups[0].id}`, { headers: { Cookie: cookie } });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.backup.changes.tasks.removed.length, 1);
    assert.equal(previewBody.backup.changes.totalChanges >= 1, true);

    const restored = await fetch(`${baseUrl}/api/backups/${listedBackups[0].id}/restore`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": auth.csrf },
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).config.tasks.length, 0);
    assert.equal(store.getPublicConfig().tasks.length, 0);

    await store.appendLog({ type: "task-run", status: "sent", detail: "test" });
    const cleared = await fetch(`${baseUrl}/api/logs`, {
      method: "DELETE",
      headers: { Cookie: cookie, "X-CSRF-Token": auth.csrf },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await store.readLogs(), []);
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("version 2 task credentials migrate to reusable accounts without losing the session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-migration-"));
  const key = randomBytes(32);
  const taskId = "06bc56e4-c8c0-4c6e-8895-c781a6ab2186";
  const now = "2026-07-27T02:00:00.000Z";
  const legacy = {
    version: 2,
    enabled: true,
    tasks: [{
      ...taskPayload(),
      id: taskId,
      baseUrl: "https://monkeycode-ai.com",
      sessionEncrypted: encryptJson({ session: "migrated-private-cookie" }, key),
      sessionUpdatedAt: now,
      promptVersions: [],
      createdAt: now,
      updatedAt: now,
    }],
    notifications: [],
    updatedAt: now,
  };
  delete legacy.tasks[0].session;
  await writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  try {
    const store = await new DataStore(directory, key).init();
    const publicConfig = store.getPublicConfig();
    const resolvedTask = store.getTask(taskId, { withSession: true });
    assert.equal(publicConfig.version, 10);
    assert.equal(publicConfig.accounts.length, 1);
    assert.equal(publicConfig.accounts[0].sessionConfigured, true);
    assert.equal(publicConfig.tasks[0].accountId, publicConfig.accounts[0].id);
    assert.equal(publicConfig.tasks[0].keepAwake, true);
    assert.equal(publicConfig.tasks[0].completion.enabled, false);
    assert.equal(publicConfig.tasks[0].failurePolicy.autoPauseAfter, 0);
    assert.equal(resolvedTask.session, "migrated-private-cookie");
    assert.equal(resolvedTask.baseUrl, "https://monkeycode-ai.com");

    const current = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    assert.equal(current.version, 10);
    assert.equal("sessionEncrypted" in current.tasks[0], false);
    const backups = await readdir(path.join(directory, "backups"));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(await readFile(path.join(directory, "backups", backups[0]), "utf8"));
    assert.equal(backup.version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("version 3 accounts migrate to browser-bridge configuration without changing credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-v3-migration-"));
  const key = randomBytes(32);
  const accountId = "5130e4fb-3fd7-43f7-bbc2-939e15612697";
  const now = "2026-07-27T02:00:00.000Z";
  const legacy = {
    version: 3,
    enabled: true,
    accounts: [{
      id: accountId,
      name: "Existing account",
      baseUrl: "https://monkeycode-ai.com",
      sessionEncrypted: encryptJson({ session: "existing-private-cookie" }, key),
      sessionUpdatedAt: now,
      lastValidatedAt: null,
      lastValidationStatus: "unknown",
      userId: null,
      userName: null,
      createdAt: now,
      updatedAt: now,
    }],
    tasks: [],
    notifications: [],
    updatedAt: now,
  };
  await writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  try {
    const store = await new DataStore(directory, key).init();
    const account = store.getAccount(accountId, { withSession: true });
    assert.equal(store.getPublicConfig().version, 10);
    assert.equal(account.session, "existing-private-cookie");
    assert.equal(account.sessionSource, "manual");
    assert.equal(account.sessionExpiresAt, null);
    const current = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    assert.deepEqual(current.browserBridges, []);
    const backups = await readdir(path.join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(directory, "backups", backups[0]), "utf8")).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("version 5 configuration gains persistent remote sync defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-v5-migration-"));
  const key = randomBytes(32);
  const now = "2026-07-27T02:00:00.000Z";
  const legacy = {
    version: 5,
    enabled: true,
    accounts: [],
    tasks: [],
    notifications: [],
    browserBridges: [],
    updatedAt: now,
  };
  await writeFile(path.join(directory, "config.json"), JSON.stringify(legacy), "utf8");

  try {
    const store = await new DataStore(directory, key).init();
    assert.deepEqual(store.getPublicConfig().remoteSettings, {
      enabled: true,
      intervalMinutes: 10,
      quotaWarningPercent: 20,
      quotaGuardEnabled: false,
      quotaReservePercent: 10,
      quotaReserveTokens: 0,
    });
    const current = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    assert.equal(current.version, 10);
    assert.deepEqual(current.remoteSettings, store.getPublicConfig().remoteSettings);
    const backups = await readdir(path.join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(directory, "backups", backups[0]), "utf8")).version, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an enabled task requires an account with a configured cookie", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-account-"));
  try {
    const store = await new DataStore(directory, randomBytes(32)).init();
    const account = await store.upsertAccount({
      name: "Cookie pending",
      baseUrl: "https://monkeycode-ai.com",
    });
    await assert.rejects(
      store.upsertTask({
        ...taskPayload(),
        accountId: account.id,
        baseUrl: undefined,
        session: "",
      }),
      /requires an account with a session cookie/,
    );
    await store.deleteAccount(account.id);
    assert.equal(store.getPublicConfig().accounts.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("overview can skip activity logs when the active page does not need them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-overview-"));
  const store = await new DataStore(directory, randomBytes(32)).init();
  const notifications = new NotificationService(store);
  const runner = new TaskRunner(store, notifications);
  const panel = new PanelServer({
    store,
    notifications,
    runner,
    password: "correct horse battery staple",
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
  });
  const address = await panel.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await store.appendLog({ type: "task-run", status: "sent", detail: "recent activity" });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];

    const lightweight = await fetch(`${baseUrl}/api/overview?activity=0`, { headers: { Cookie: cookie } });
    assert.deepEqual((await lightweight.json()).logs, []);

    const detailed = await fetch(`${baseUrl}/api/overview?activity=1`, { headers: { Cookie: cookie } });
    assert.equal((await detailed.json()).logs.length, 1);
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("panel readiness verifies that its durable store is available", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-ready-"));
  const store = await new DataStore(directory, randomBytes(32)).init();
  const notifications = new NotificationService(store);
  const runner = new TaskRunner(store, notifications);
  const panel = new PanelServer({
    store,
    notifications,
    runner,
    password: "correct horse battery staple",
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
  });
  const address = await panel.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const live = await fetch(`${baseUrl}/api/health`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).ok, true);

    const ready = await fetch(`${baseUrl}/api/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      storage: { version: 10 },
    });

    store.readiness = async () => { throw new Error("disk is read-only"); };
    const unavailable = await fetch(`${baseUrl}/api/readyz`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { ok: false, error: "storage-unavailable" });
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("panel serves cached browser assets with Brotli and HEAD semantics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-panel-assets-"));
  const store = await new DataStore(directory, randomBytes(32)).init();
  const notifications = new NotificationService(store);
  const runner = new TaskRunner(store, notifications);
  const panel = new PanelServer({
    store,
    notifications,
    runner,
    password: "correct horse battery staple",
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
  });
  const address = await panel.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const iconAsset = await fetch(`${baseUrl}/vendor/lucide.js`, { headers: { "Accept-Encoding": "br" } });
    assert.equal(iconAsset.status, 200);
    assert.equal(iconAsset.headers.get("content-encoding"), "br");
    assert.match(await iconAsset.text(), /Generated by scripts\/build-icons\.mjs/);

    const head = await fetch(`${baseUrl}/app.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    await panel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
