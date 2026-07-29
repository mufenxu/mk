import assert from "node:assert/strict";
import test from "node:test";

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
