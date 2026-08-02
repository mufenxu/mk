import assert from "node:assert/strict";
import test from "node:test";

import { pruneTerminalJobs, selectWorker } from "../src/scheduler.mjs";

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
