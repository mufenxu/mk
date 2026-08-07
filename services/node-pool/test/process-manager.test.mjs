import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanWorkerConfig } from "../src/config.mjs";
import * as processManager from "../src/process-manager.mjs";

const { ProjectManager } = processManager;

test("project launch uses a transient systemd scope when resource control is available", () => {
  const launch = processManager.projectLaunch({
    name: "api",
    start: "node app.mjs",
    resources: { cpu: 0.5, memoryMb: 384 },
  }, {
    mode: "auto",
    available: true,
    maxProcesses: 48,
  });

  assert.equal(launch.file, "systemd-run");
  assert.equal(launch.shell, false);
  assert.deepEqual(launch.args.slice(0, 7), [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--property=CPUQuota=50%",
    "--property=MemoryMax=384M",
    "--property=TasksMax=48",
  ]);
  assert.deepEqual(launch.args.slice(-3), ["/bin/sh", "-lc", "exec node app.mjs"]);
});

test("project launch keeps the portable shell fallback when isolation is unavailable", () => {
  assert.deepEqual(processManager.projectLaunch({
    name: "api",
    start: "node app.mjs",
    resources: { cpu: 0.5, memoryMb: 384 },
  }, {
    mode: "auto",
    available: false,
    maxProcesses: 48,
  }), {
    file: "node app.mjs",
    args: [],
    shell: true,
    enforced: false,
  });
});

test("failed deployment restores the previously running commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-pool-rollback-"));
  try {
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
    const manager = new ProjectManager(config);
    manager.state.projects.api = {
      status: "running",
      desiredStatus: "running",
      pid: 1234,
      ref: "stable",
      commit: "good-commit",
    };

    const checkouts = [];
    manager.stop = async (_name, { desiredStatus } = {}) => {
      manager.state.projects.api.status = "stopped";
      manager.state.projects.api.desiredStatus = desiredStatus ?? "stopped";
    };
    manager.ensureRepository = async (_project, ref) => {
      checkouts.push(ref);
      return ref === "candidate" ? "bad-commit" : "good-commit";
    };
    manager.start = async (_name, commit) => {
      if (commit === "bad-commit") throw new Error("candidate failed health check");
      manager.state.projects.api = {
        ...manager.state.projects.api,
        status: "running",
        desiredStatus: "running",
        commit,
      };
      return { project: "api", status: "running", commit };
    };

    await assert.rejects(
      manager.deploy("api", "candidate"),
      /candidate failed health check.*previous release restored/i,
    );
    assert.deepEqual(checkouts, ["candidate", "good-commit"]);
    assert.equal(manager.state.projects.api.status, "running");
    assert.equal(manager.state.projects.api.commit, "good-commit");
    assert.equal(manager.state.projects.api.ref, "stable");
    assert.match(manager.state.projects.api.lastDeploymentError, /candidate failed health check/);
    assert.ok(manager.state.projects.api.lastRollbackAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
