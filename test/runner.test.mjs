import assert from "node:assert/strict";
import test from "node:test";

import { AuthExpiredError } from "../src/errors.mjs";
import { TaskRunner } from "../src/runner.mjs";

test("emits one session-age warning per stored cookie", async () => {
  const now = new Date("2026-07-27T01:00:00.000Z");
  const task = {
    id: "task-1",
    name: "Daily report",
    enabled: true,
    sessionConfigured: true,
    sessionUpdatedAt: new Date(now.getTime() - 26 * 86_400_000).toISOString(),
    schedule: {
      mode: "daily",
      time: "23:59",
      timeZone: "Asia/Shanghai",
      weekdays: [1, 2, 3, 4, 5],
      catchUp: true,
      includeDates: [],
      excludeDates: [],
    },
  };
  const logs = [];
  const notices = [];
  let scheduleState = {};
  const store = {
    getPublicConfig: () => ({ enabled: true, tasks: [task] }),
    readScheduleState: async () => scheduleState,
    writeScheduleState: async (value) => { scheduleState = structuredClone(value); },
    appendLog: async (value) => { logs.push(value); },
  };
  const notifications = {
    notify: async (event, context) => { notices.push({ event, context }); },
  };
  const runner = new TaskRunner(store, notifications);

  await runner.tick(now);
  await runner.tick(now);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "session-warning");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].event, "session-warning");
  assert.equal(scheduleState[task.id].sessionWarningFor, task.sessionUpdatedAt);
});

test("emits one account warning before exact expiry and one expiry event after it", async () => {
  const now = new Date("2026-07-27T01:00:00.000Z");
  const account = {
    id: "account-1",
    name: "Primary account",
    sessionConfigured: true,
    sessionUpdatedAt: "2026-07-20T01:00:00.000Z",
    sessionExpiresAt: "2026-07-29T01:00:00.000Z",
  };
  const logs = [];
  const notices = [];
  let scheduleState = {};
  const store = {
    getPublicConfig: () => ({ enabled: true, accounts: [account], tasks: [] }),
    readScheduleState: async () => scheduleState,
    writeScheduleState: async (value) => { scheduleState = structuredClone(value); },
    appendLog: async (value) => { logs.push(value); },
  };
  const notifications = {
    notify: async (event, context) => { notices.push({ event, context }); },
  };
  const runner = new TaskRunner(store, notifications);

  await runner.tick(now);
  await runner.tick(now);
  await runner.tick(new Date("2026-07-29T01:00:01.000Z"));
  await runner.tick(new Date("2026-07-29T01:00:01.000Z"));

  assert.deepEqual(logs.map((entry) => entry.status), ["session-warning", "auth-expired"]);
  assert.deepEqual(notices.map((entry) => entry.event), ["session-warning", "auth-expired"]);
  assert.equal(logs[0].accountId, account.id);
  assert.equal(notices[1].context.accountName, account.name);
});

test("tracks an acknowledged message until the remote task completes", async () => {
  let clock = 0;
  const snapshots = [
    { status: "processing", lastActiveAt: null, stats: { totalTokens: 100 } },
    { status: "finished", completedAt: null, stats: { totalTokens: 145 } },
  ];
  const runner = new TaskRunner({}, {}, {
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    remoteTaskDetail: async () => snapshots.shift(),
  });
  const result = await runner.trackCompletion({
    baseUrl: "https://monkeycode-ai.com",
    session: "session",
    monkeyTaskId: "task",
    completion: { timeoutMinutes: 1, pollSeconds: 5 },
  }, { status: "finished", completedAt: "2026-07-27T00:00:00.000Z", stats: { totalTokens: 100 } }, "2026-07-27T01:00:00.000Z");

  assert.equal(result.status, "completed");
  assert.equal(result.tokenDelta, 45);
});

test("treats stream task-ended as completion without polling for finished status", async () => {
  const task = {
    id: "task-1",
    name: "Daily report",
    accountId: "account-1",
    monkeyTaskId: "remote-task",
    baseUrl: "https://monkeycode-ai.com",
    session: "session",
    prompt: "Report",
    dryRun: false,
    dedupe: true,
    retry: { attempts: 1, delaySeconds: 0 },
    completion: { enabled: true, timeoutMinutes: 1, pollSeconds: 5 },
    failurePolicy: { autoPauseAfter: 3 },
    schedule: { timeZone: "Asia/Shanghai" },
  };
  const logs = [];
  const notices = [];
  let detailCalls = 0;
  const store = {
    getTask: () => task,
    getPublicConfig: () => ({
      operationsSettings: { accountConcurrency: 1 },
      remoteSettings: { quotaGuardEnabled: false },
    }),
    taskStateFile: () => "state.json",
    appendLog: async (entry) => { logs.push(entry); },
  };
  const runner = new TaskRunner(store, { notify: async (event) => { notices.push(event); } }, {
    wait: async () => { throw new Error("trackCompletion should not poll after stream completion"); },
    remoteTaskDetail: async () => {
      detailCalls += 1;
      return { status: "processing", stats: { totalTokens: detailCalls === 1 ? 100 : 145 } };
    },
    runOnce: async () => ({
      status: "sent",
      acceptedAt: "2026-07-27T01:00:00.000Z",
      streamCompletion: { completionStatus: "completed" },
    }),
  });

  const result = await runner.execute(task.id, { mode: "send" });

  assert.equal(result.status, "completed");
  assert.equal(result.tokenDelta, 45);
  assert.equal(detailCalls, 2);
  assert.deepEqual(logs.map((entry) => entry.status), ["accepted", "completed"]);
  assert.deepEqual(notices, ["completed"]);
});

test("does not start a second polling timeout after stream completion times out", async () => {
  const task = {
    id: "task-1",
    name: "Daily report",
    accountId: "account-1",
    monkeyTaskId: "remote-task",
    baseUrl: "https://monkeycode-ai.com",
    session: "session",
    prompt: "Report",
    dryRun: false,
    dedupe: true,
    retry: { attempts: 1, delaySeconds: 0 },
    completion: { enabled: true, timeoutMinutes: 1, pollSeconds: 5 },
    failurePolicy: { autoPauseAfter: 3 },
    schedule: { timeZone: "Asia/Shanghai" },
  };
  const logs = [];
  const store = {
    getTask: () => task,
    getPublicConfig: () => ({
      operationsSettings: { accountConcurrency: 1 },
      remoteSettings: { quotaGuardEnabled: false },
    }),
    taskStateFile: () => "state.json",
    appendLog: async (entry) => { logs.push(entry); },
  };
  const runner = new TaskRunner(store, { notify: async () => {} }, {
    wait: async () => { throw new Error("trackCompletion should not run after stream timeout"); },
    remoteTaskDetail: async () => ({ status: "processing", stats: { totalTokens: 100 } }),
    runOnce: async () => ({
      status: "sent",
      acceptedAt: "2026-07-27T01:00:00.000Z",
      streamCompletion: { completionStatus: "stream-timeout" },
    }),
  });

  const result = await runner.execute(task.id, { mode: "send" });

  assert.equal(result.status, "completion-timeout");
  assert.deepEqual(logs.map((entry) => entry.status), ["accepted", "completion-timeout"]);
});

test("automatically pauses a task after consecutive scheduled failures", async () => {
  let scheduleState = { task: { consecutiveFailures: 2, occurrences: [] } };
  const disabled = [];
  const logs = [];
  const notices = [];
  const store = {
    readScheduleState: async () => scheduleState,
    writeScheduleState: async (value) => { scheduleState = structuredClone(value); },
    getTask: () => ({ enabled: true }),
    setTaskEnabled: async (id, enabled) => { disabled.push({ id, enabled }); },
    appendLog: async (entry) => { logs.push(entry); },
  };
  const runner = new TaskRunner(store, { notify: async (event) => { notices.push(event); } });
  await runner.finishScheduled(
    { id: "task", name: "Daily report", failurePolicy: { autoPauseAfter: 3 } },
    { key: "2026-07-27@09:00", localDate: "2026-07-27" },
    { status: "completion-timeout" },
  );

  assert.deepEqual(disabled, [{ id: "task", enabled: false }]);
  assert.equal(scheduleState.task.consecutiveFailures, 3);
  assert.equal(logs[0].status, "auto-paused");
  assert.deepEqual(notices, ["auto-paused"]);
});

test("queues tasks that share an account and starts the next task after completion", async () => {
  const tasks = new Map([
    ["task-1", { id: "task-1", name: "First", accountId: "account-1" }],
    ["task-2", { id: "task-2", name: "Second", accountId: "account-1" }],
  ]);
  const store = {
    getPublicConfig: () => ({ operationsSettings: { accountConcurrency: 1 } }),
    getTask: (id) => tasks.get(id),
  };
  const runner = new TaskRunner(store, {});
  const started = [];
  let releaseFirst;
  runner.execute = async (id) => {
    started.push(id);
    if (id === "task-1") await new Promise((resolve) => { releaseFirst = resolve; });
    return { status: "completed" };
  };

  const first = runner.start("task-1");
  const firstPromise = runner.getPendingPromise("task-1");
  const second = runner.start("task-2");
  const secondPromise = runner.getPendingPromise("task-2");
  await Promise.resolve();

  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.deepEqual(started, ["task-1"]);
  assert.equal(runner.getQueue()[0].position, 1);

  releaseFirst();
  await firstPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["task-1", "task-2"]);
  await secondPromise;
});

test("cancels a queued task without interrupting the active task", async () => {
  const tasks = new Map([
    ["task-1", { id: "task-1", name: "First", accountId: "account-1" }],
    ["task-2", { id: "task-2", name: "Second", accountId: "account-1" }],
  ]);
  const logs = [];
  let releaseFirst;
  const store = {
    getPublicConfig: () => ({ operationsSettings: { accountConcurrency: 1 } }),
    getTask: (id) => tasks.get(id),
    appendLog: async (entry) => { logs.push(entry); },
  };
  const runner = new TaskRunner(store, {});
  runner.execute = async (id) => {
    if (id === "task-1") await new Promise((resolve) => { releaseFirst = resolve; });
    return { status: "completed" };
  };

  runner.start("task-1");
  runner.start("task-2");
  const queuedPromise = runner.getPendingPromise("task-2");
  await Promise.resolve();
  const cancelled = await runner.cancel("task-2");

  assert.deepEqual(cancelled, { cancelled: true, state: "queued" });
  assert.equal((await queuedPromise).status, "cancelled");
  assert.equal(runner.getQueue().length, 0);
  assert.equal(logs[0].status, "cancelled");
  releaseFirst();
});

test("blocks a normal send when the configured quota reserve is reached", async () => {
  const task = {
    id: "task-1",
    name: "Daily report",
    accountId: "account-1",
    monkeyTaskId: "remote-task",
    baseUrl: "https://monkeycode-ai.com",
    session: "session",
    prompt: "Report",
    dryRun: false,
    retry: { attempts: 3, delaySeconds: 0 },
    completion: { enabled: false },
    schedule: { timeZone: "Asia/Shanghai" },
  };
  const logs = [];
  const notices = [];
  const store = {
    getTask: () => task,
    getPublicConfig: () => ({
      operationsSettings: { accountConcurrency: 1 },
      remoteSettings: { quotaGuardEnabled: true, quotaReservePercent: 10, quotaReserveTokens: 1_000 },
    }),
    getAccount: () => ({ remoteSnapshot: { wallet: { dailyTokenBalance: 900, dailyTokenLimit: 10_000 } } }),
    appendLog: async (entry) => { logs.push(entry); },
  };
  const runner = new TaskRunner(store, { notify: async (event) => { notices.push(event); } });

  const result = await runner.execute(task.id, { mode: "send" });

  assert.equal(result.status, "quota-blocked");
  assert.equal(result.attempts, 0);
  assert.equal(logs[0].status, "quota-blocked");
  assert.deepEqual(notices, ["quota-low"]);
});

test("renews and retries once when the runtime session check reports an expired cookie", async () => {
  let session = "stale-session";
  let validationStatus = "valid";
  const validations = [];
  const attemptedSessions = [];
  const task = () => ({
    id: "task-1",
    name: "Daily report",
    accountId: "account-1",
    monkeyTaskId: "remote-task",
    baseUrl: "https://monkeycode-ai.com",
    session,
    sessionExpiresAt: "2026-09-01T00:00:00.000Z",
    prompt: "Report",
    dryRun: false,
    dedupe: true,
    retry: { attempts: 1, delaySeconds: 0 },
    completion: { enabled: false },
    schedule: { timeZone: "Asia/Shanghai" },
  });
  const store = {
    getTask: () => task(),
    getAccount: () => ({
      id: "account-1",
      autoLoginEnabled: true,
      loginConfigured: true,
      sessionConfigured: true,
      sessionExpiresAt: "2026-09-01T00:00:00.000Z",
      lastValidationStatus: validationStatus,
    }),
    getPublicConfig: () => ({
      operationsSettings: { accountConcurrency: 1 },
      remoteSettings: { quotaGuardEnabled: false },
    }),
    taskStateFile: () => "state.json",
    recordAccountValidation: async (id, status) => {
      validationStatus = status;
      validations.push({ id, status });
    },
    appendLog: async () => {},
  };
  let renewals = 0;
  const autoLogin = {
    renewIfNeeded: async (account) => {
      if (account.lastValidationStatus !== "invalid") return { renewed: false };
      renewals += 1;
      session = "renewed-session";
      validationStatus = "valid";
      return { renewed: true };
    },
  };
  const runner = new TaskRunner(store, { notify: async () => {} }, {
    autoLogin,
    runOnce: async (config) => {
      attemptedSessions.push(config.session);
      if (config.session === "stale-session") throw new AuthExpiredError();
      return { status: "sent" };
    },
  });

  const result = await runner.execute("task-1", { mode: "force" });

  assert.equal(result.status, "sent");
  assert.deepEqual(attemptedSessions, ["stale-session", "renewed-session"]);
  assert.deepEqual(validations, [
    { id: "account-1", status: "invalid" },
    { id: "account-1", status: "valid" },
  ]);
  assert.equal(renewals, 1);
});

test("uses the runtime session check instead of blocking on the stored expiry time", async () => {
  const task = {
    id: "task-1",
    name: "Daily report",
    accountId: "account-1",
    monkeyTaskId: "remote-task",
    baseUrl: "https://monkeycode-ai.com",
    session: "still-valid-session",
    sessionExpiresAt: "2026-08-01T00:00:00.000Z",
    prompt: "Report",
    dryRun: false,
    dedupe: true,
    retry: { attempts: 1, delaySeconds: 0 },
    completion: { enabled: false },
    schedule: { timeZone: "Asia/Shanghai" },
  };
  let runCalls = 0;
  const store = {
    getTask: () => task,
    getPublicConfig: () => ({
      operationsSettings: { accountConcurrency: 1 },
      remoteSettings: { quotaGuardEnabled: false },
    }),
    taskStateFile: () => "state.json",
    appendLog: async () => {},
  };
  const runner = new TaskRunner(store, { notify: async () => {} }, {
    runOnce: async () => {
      runCalls += 1;
      return { status: "sent" };
    },
  });

  const result = await runner.execute("task-1", {
    mode: "force",
    now: new Date("2026-08-13T00:00:00.000Z"),
  });

  assert.equal(result.status, "sent");
  assert.equal(runCalls, 1);
});
