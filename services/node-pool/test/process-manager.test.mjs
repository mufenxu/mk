import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanWorkerConfig } from "../src/config.mjs";
import { ProjectManager } from "../src/process-manager.mjs";

test("legacy running state becomes recoverable desired state when its process is gone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-pool-manager-"));
  try {
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "runtime", "state.json"), JSON.stringify({
      version: 1,
      projects: {
        api: {
          status: "running",
          pid: 2147483647,
          commit: "abc123",
        },
      },
    }));
    const config = cleanWorkerConfig({
      version: 1,
      nodeId: "worker-01",
      controllerUrl: "https://mk.example.test/node-pool",
      rootDir: root,
      publicUrlTemplate: "https://{port}-environment.example.test",
      projects: {
        api: {
          repo: "https://example.test/api.git",
          start: "node app.mjs",
          port: 3000,
        },
      },
    });
    const manager = new ProjectManager(config);
    await manager.load();

    const [state] = manager.projectStates();
    assert.equal(state.status, "stopped");
    assert.equal(state.desiredStatus, "running");
    assert.equal(state.publicUrl, "https://3000-environment.example.test");
    assert.match(state.lastError, /exited unexpectedly/);

    await manager.stop("api");
    assert.equal(manager.projectStates()[0].desiredStatus, "stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile restarts a deployed project whose desired state is running", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-pool-recovery-"));
  const projectDir = path.join(root, "api");
  let manager;
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "app.mjs"), "setInterval(() => {}, 1000);\n");
    const config = cleanWorkerConfig({
      version: 1,
      nodeId: "worker-01",
      controllerUrl: "https://mk.example.test/node-pool",
      rootDir: root,
      projects: {
        api: {
          repo: "https://example.test/api.git",
          start: "node app.mjs",
        },
      },
    });
    manager = new ProjectManager(config);
    await manager.load();
    const first = await manager.start("api");
    await manager.stop("api", { desiredStatus: "running" });

    const [recovered] = await manager.reconcile();
    assert.equal(recovered.status, "running");
    assert.equal(recovered.recovered, true);
    assert.notEqual(recovered.pid, first.pid);
    assert.equal(manager.projectStates()[0].lastRecoveredAt !== null, true);
  } finally {
    await manager?.stop("api").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
