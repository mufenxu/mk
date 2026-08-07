import assert from "node:assert/strict";
import test from "node:test";

import { pruneTerminalJobs, selectWorker, summarizeState } from "../src/scheduler.mjs";

function worker(id, projects) {
  return {
    id,
    status: "online",
    lastSeenAt: new Date().toISOString(),
    projects,
    labels: ["node"],
    capacity: { cpu: 1, memoryMb: 1024, diskMb: 1024 },
    metrics: { diskFreeMb: 1024 },
    allocations: [],
    maxConcurrentJobs: 1,
  };
}

test("scheduler only selects workers that allow the requested project", () => {
  const state = {
    workers: {
      denied: worker("denied", ["other-project"]),
      allowed: worker("allowed", ["example-api"]),
    },
    jobs: [],
  };
  const job = {
    project: "example-api",
    preferredWorkerId: null,
    requirements: { cpu: 0.1, memoryMb: 128, labels: ["node"] },
  };
  assert.equal(selectWorker(state, job)?.id, "allowed");
});

test("terminal job retention removes expired history without touching queued or leased work", () => {
  const now = new Date("2026-08-02T00:00:00.000Z").getTime();
  const state = {
    workers: {},
    jobs: [
      { id: "expired", status: "completed", finishedAt: "2026-06-01T00:00:00.000Z" },
      { id: "recent", status: "failed", finishedAt: "2026-08-01T00:00:00.000Z" },
      { id: "queued", status: "queued", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "leased", status: "leased", leaseExpiresAt: "2026-08-02T00:10:00.000Z" },
    ],
  };

  assert.equal(pruneTerminalJobs(state, { now, retentionMs: 7 * 86_400_000, maxEntries: 100 }), true);
  assert.deepEqual(state.jobs.map((job) => job.id), ["recent", "queued", "leased"]);
});

test("state summary reports worker availability and deployment backlog", () => {
  const now = new Date("2026-08-07T12:00:00.000Z").getTime();
  const current = worker("current", ["api"]);
  current.lastSeenAt = new Date(now - 10_000).toISOString();
  const stale = worker("stale", ["api"]);
  stale.lastSeenAt = new Date(now - 120_000).toISOString();
  const state = {
    updatedAt: "2026-08-07T11:59:00.000Z",
    workers: { current, stale },
    jobs: [
      { status: "queued", createdAt: "2026-08-07T11:55:00.000Z" },
      { status: "leased", createdAt: "2026-08-07T11:56:00.000Z" },
      { status: "failed", createdAt: "2026-08-07T11:57:00.000Z" },
    ],
  };

  assert.deepEqual(summarizeState(state, now), {
    updatedAt: state.updatedAt,
    workerCounts: { total: 2, online: 1, offline: 1 },
    jobCounts: { queued: 1, leased: 1, completed: 0, failed: 1, cancelled: 0 },
    oldestQueuedAt: "2026-08-07T11:55:00.000Z",
  });
});
