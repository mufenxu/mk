import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { EnvironmentKeeper } from "../src/environment-keeper.mjs";
import { DataStore } from "../src/storage.mjs";

const monkeyTaskId = "678fed52-b2a8-467f-a94c-3b0fde6f1c89";

function waitFor(check, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for condition"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function taskInput(accountId, name) {
  return {
    name,
    monkeyTaskId,
    accountId,
    enabled: false,
    keepAwake: true,
    dryRun: false,
    dedupe: true,
    prompt: "Continue {{date}}",
    schedule: { mode: "daily", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] },
    retry: { attempts: 1, delaySeconds: 0 },
  };
}

async function mockControlServer({ authorized = true } = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state = { upgrades: 0, connections: 0, applicationMessages: 0 };

  server.on("upgrade", (request, socket, head) => {
    state.upgrades += 1;
    if (!authorized) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    assert.equal(request.url, `/api/v1/users/tasks/control?id=${monkeyTaskId}`);
    assert.equal(request.headers.cookie, "monkeycode_ai_session=keeper-test-session");
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    state.connections += 1;
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
    }, 15);
    ws.on("message", () => { state.applicationMessages += 1; });
    ws.on("close", () => clearInterval(timer));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("keeper wakes through one deduplicated control channel without sending task input", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-keeper-"));
  const remote = await mockControlServer();
  const store = await new DataStore(directory, randomBytes(32)).init();
  const account = await store.upsertAccount({
    name: "Keeper account",
    baseUrl: remote.baseUrl,
    session: "keeper-test-session",
  });
  const first = await store.upsertTask(taskInput(account.id, "First local schedule"));
  const second = await store.upsertTask(taskInput(account.id, "Second local schedule"));
  const keeper = new EnvironmentKeeper(store, {
    reconcileIntervalMs: 50,
    staleAfterMs: 200,
    staleCheckMs: 25,
    reconnectDelays: [10, 25],
  });

  try {
    await keeper.start();
    await waitFor(() => keeper.statusForTask(store.getTask(first.id)).status === "connected");
    await waitFor(() => keeper.statusForTask(store.getTask(first.id)).lastPingAt);
    assert.equal(remote.state.connections, 1);
    assert.equal(remote.state.applicationMessages, 0);
    assert.equal(keeper.statusForTask(store.getTask(first.id)).sharedTaskCount, 2);
    assert.equal(keeper.statusForTask(store.getTask(second.id)).status, "connected");

    await store.setEnabled(false);
    await keeper.reconcile();
    assert.equal(keeper.statusForTask(store.getTask(first.id)).status, "paused");
  } finally {
    keeper.stop();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeper stops retrying when MonkeyCode rejects the account cookie", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-keeper-auth-"));
  const remote = await mockControlServer({ authorized: false });
  const store = await new DataStore(directory, randomBytes(32)).init();
  const account = await store.upsertAccount({
    name: "Expired account",
    baseUrl: remote.baseUrl,
    session: "keeper-test-session",
  });
  const task = await store.upsertTask(taskInput(account.id, "Auth failure"));
  const keeper = new EnvironmentKeeper(store, { reconnectDelays: [10], reconcileIntervalMs: 25 });

  try {
    await keeper.start();
    await waitFor(() => keeper.statusForTask(store.getTask(task.id)).status === "auth-expired");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(remote.state.upgrades, 1);
  } finally {
    keeper.stop();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
