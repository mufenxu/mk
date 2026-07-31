import assert from "node:assert/strict";
import test from "node:test";

import { cleanWorkerConfig, projectPublicUrl } from "../src/config.mjs";

function workerConfig(overrides = {}) {
  return {
    version: 1,
    nodeId: "worker-01",
    controllerUrl: "https://mk.example.test/node-pool",
    rootDir: "/workspace/.worker",
    publicUrlTemplate: "https://{port}-environment.example.test",
    projects: {
      api: {
        repo: "https://example.test/api.git",
        start: "node app.mjs",
        port: 3000,
      },
    },
    ...overrides,
  };
}

test("worker config resolves project public URLs and recovery defaults", () => {
  const config = cleanWorkerConfig(workerConfig());
  assert.equal(projectPublicUrl(config, config.projects.api), "https://3000-environment.example.test");
  assert.equal(config.projects.api.restartPolicy, "unless-stopped");
  assert.equal(config.reconcileIntervalSeconds, 15);
  assert.equal(config.recovery.healthFailureThreshold, 3);
});

test("project public URL overrides the worker template", () => {
  const input = workerConfig();
  input.projects.api.publicUrl = "https://api.example.test";
  const config = cleanWorkerConfig(input);
  assert.equal(projectPublicUrl(config, config.projects.api), "https://api.example.test");
});

test("public URL templates must contain a port placeholder", () => {
  assert.throws(() => cleanWorkerConfig(workerConfig({ publicUrlTemplate: "https://environment.example.test" })), /must contain \{port\}/);
});
