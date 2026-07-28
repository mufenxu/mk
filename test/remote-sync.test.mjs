import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getRemoteAccountSnapshot, getRemoteTaskDetail } from "../src/client.mjs";
import { RemoteSyncService } from "../src/remote-sync.mjs";
import { DataStore } from "../src/storage.mjs";

const session = "remote-sync-session";
const remoteTaskId = "678fed52-b2a8-467f-a94c-3b0fde6f1c89";

async function createRemoteMock() {
  const requests = [];
  let upgrades = 0;
  const activeTask = {
    id: remoteTaskId,
    title: "",
    summary: "项目部署状态确认",
    content: "请确认项目状态",
    status: "processing",
    type: "develop",
    created_at: "2026-07-27T03:50:46Z",
    last_active_at: "2026-07-27T10:27:31Z",
    completed_at: "0001-01-01T00:00:00Z",
    model: {
      id: "model-1",
      provider: "monkeycode-basic",
      model: "qwen3.5-plus",
      context_limit: 200000,
      output_limit: 32000,
      thinking_enabled: true,
    },
    stats: { input_tokens: 100, output_tokens: 20, total_tokens: 120, llm_requests: 2 },
    virtualmachine: {
      id: "vm-1",
      environment_id: "env-1",
      status: "online",
      os: "Debian 12 bookworm",
      cores: 2,
      memory: 8352858112,
      life_time_seconds: 0,
      created_at: "2026-07-27T03:50:46Z",
      external_ip: "198.51.100.8",
      conditions: [
        { type: "Hibernated", reason: "NotHibernated", last_transition_time: 1785154342158 },
        { type: "Ready", status: 2, reason: "Ready", message: "Environment ready", last_transition_time: 1785154342158 },
      ],
    },
  };
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Content-Type", "application/json");
    if (request.headers.cookie !== `monkeycode_ai_session=${session}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ code: 401 }));
      return;
    }
    const url = new URL(request.url, "http://localhost");
    let payload;
    if (url.pathname === "/api/v1/users/status") {
      payload = { data: { user: { id: "user-1", name: "mufenxu", email: "hidden@example.com", role: "individual", status: "active" } } };
    } else if (url.pathname === "/api/v1/users/subscription") {
      payload = { data: { plan: "basic", auto_renew: false, enable_credit_consumption: true } };
    } else if (url.pathname === "/api/v1/users/wallet") {
      payload = { data: { balance: 20152047, daily_token_balance: 27703209, daily_token_limit: 30000000 } };
    } else if (url.pathname === "/api/v1/users/tasks") {
      payload = url.searchParams.get("status") === "pending,processing"
        ? { data: { tasks: [activeTask], page_info: { has_next_page: false } } }
        : { data: { tasks: [], page_info: { has_next_page: false } } };
    } else if (url.pathname === `/api/v1/users/tasks/${remoteTaskId}`) {
      payload = { data: activeTask };
    } else if (url.pathname === "/api/v1/teams/task-vm-idle-policy") {
      response.statusCode = 403;
      response.end(JSON.stringify({ code: 403 }));
      return;
    } else {
      response.statusCode = 404;
      payload = { code: 404 };
    }
    response.end(JSON.stringify({ code: 0, ...payload }));
  });
  server.on("upgrade", (request, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    requests,
    get upgrades() { return upgrades; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function config(baseUrl) {
  return { baseUrl, session, timeoutMs: 2_000 };
}

test("remote snapshot uses only HTTP metadata APIs and removes sensitive fields", async () => {
  const mock = await createRemoteMock();
  try {
    const snapshot = await getRemoteAccountSnapshot(config(mock.baseUrl));
    assert.equal(snapshot.profile.name, "mufenxu");
    assert.equal("email" in snapshot.profile, false);
    assert.equal(snapshot.subscription.plan, "basic");
    assert.equal(snapshot.wallet.dailyTokenLimit, 30000000);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].name, "项目部署状态确认");
    assert.equal(snapshot.tasks[0].completedAt, null);
    assert.equal(snapshot.tasks[0].environment.state, "running");
    assert.equal("externalIp" in snapshot.tasks[0].environment, false);
    assert.deepEqual(snapshot.idlePolicy, { available: false });
    assert.equal(mock.upgrades, 0);
    assert.equal(mock.requests.some((url) => /stream|control/.test(url)), false);

    const detail = await getRemoteTaskDetail(config(mock.baseUrl), remoteTaskId);
    assert.equal(detail.model.contextLimit, 200000);
    assert.equal(detail.stats.totalTokens, 120);
    assert.equal(mock.upgrades, 0);
  } finally {
    await mock.close();
  }
});

test("remote sync persists a sanitized snapshot without exposing the cookie", async () => {
  const mock = await createRemoteMock();
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-remote-sync-"));
  const notices = [];
  try {
    const store = await new DataStore(directory, randomBytes(32)).init();
    const account = await store.upsertAccount({ name: "主账号", baseUrl: mock.baseUrl.toString(), session });
    const service = new RemoteSyncService(store, { notify: async (event, context) => notices.push({ event, context }) }, { timeoutMs: 2_000 });
    const updated = await service.syncAccount(account.id, { trigger: "test" });
    assert.equal(updated.remoteSyncStatus, "synced");
    assert.equal(updated.remoteSnapshot.profile.name, "mufenxu");
    assert.equal(updated.remoteSnapshot.tasks[0].id, remoteTaskId);
    assert.equal(updated.remoteSnapshot.alerts.length, 0);
    assert.equal(notices.length, 0);
    assert.equal(store.getAccount(account.id, { withSession: true }).session, session);
    assert.equal(mock.upgrades, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
