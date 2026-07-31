import assert from "node:assert/strict";
import test from "node:test";

import { selectWorker } from "../src/scheduler.mjs";

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
