import assert from "node:assert/strict";
import test from "node:test";

import { NodePoolMonitor } from "../src/node-pool-monitor.mjs";

function overview({ offline = true, failedJob = true, backlog = true } = {}) {
  return {
    available: true,
    workers: [{ id: "worker-01", online: !offline }],
    jobs: failedJob ? [{ id: "job-01", project: "api", status: "failed", error: "build failed" }] : [],
    workerCounts: { total: 1, online: offline ? 0 : 1, offline: offline ? 1 : 0 },
    jobCounts: { queued: backlog ? 1 : 0, leased: 0, completed: 0, failed: failedJob ? 1 : 0, cancelled: 0 },
    oldestQueuedAt: backlog ? "2026-08-07T11:00:00.000Z" : null,
  };
}

test("node-pool monitor de-duplicates failures and re-arms after recovery", async () => {
  const snapshots = [
    overview(),
    overview(),
    overview({ offline: false, failedJob: false, backlog: false }),
    overview(),
  ];
  const events = [];
  const monitor = new NodePoolMonitor({
    nodePool: { overview: async () => snapshots.shift() },
    notifications: { notify: async (event, context) => events.push({ event, context }) },
    backlogMinutes: 10,
  });
  const now = new Date("2026-08-07T12:00:00.000Z").getTime();

  await monitor.check(now);
  assert.deepEqual(events.map((entry) => entry.event), ["node-offline", "deployment-failed", "deployment-backlog"]);
  await monitor.check(now);
  assert.equal(events.length, 3);
  await monitor.check(now);
  await monitor.check(now);
  assert.deepEqual(events.map((entry) => entry.event), [
    "node-offline",
    "deployment-failed",
    "deployment-backlog",
    "node-offline",
    "deployment-failed",
    "deployment-backlog",
  ]);
});

test("node-pool monitor reports controller outages once until it recovers", async () => {
  const results = [new Error("controller unavailable"), new Error("controller unavailable"), overview({ offline: false, failedJob: false, backlog: false }), new Error("controller unavailable")];
  const events = [];
  const monitor = new NodePoolMonitor({
    nodePool: {
      overview: async () => {
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    },
    notifications: { notify: async (event, context) => events.push({ event, context }) },
  });

  await monitor.check();
  await monitor.check();
  await monitor.check();
  await monitor.check();
  assert.deepEqual(events.map((entry) => entry.event), ["node-pool-unavailable", "node-pool-unavailable"]);
});
