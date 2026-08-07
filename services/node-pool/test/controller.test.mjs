import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const controllerFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "controller.mjs");

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealthy(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      // The controller is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Controller did not become healthy");
}

async function request(baseUrl, pathname, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("worker heartbeats update memory without rewriting durable controller state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-pool-controller-"));
  const stateFile = path.join(directory, "state.json");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "a".repeat(32);
  const controller = spawn(process.execPath, [controllerFile], {
    env: {
      ...process.env,
      MK_CONTROLLER_HOST: "127.0.0.1",
      MK_CONTROLLER_PORT: String(port),
      MK_STATE_FILE: stateFile,
      MK_ADMIN_TOKEN: adminToken,
      MK_WORKER_SECRET: "b".repeat(32),
    },
    stdio: "ignore",
  });

  try {
    await waitForHealthy(baseUrl);
    const ready = await request(baseUrl, "/readyz");
    assert.equal(ready.response.status, 200);
    assert.deepEqual(ready.body, {
      status: "ready",
      state: {
        workerCounts: { total: 0, online: 0, offline: 0 },
        jobCounts: { queued: 0, leased: 0, completed: 0, failed: 0, cancelled: 0 },
        oldestQueuedAt: null,
      },
    });
    const issued = await request(baseUrl, "/api/workers/token", { token: adminToken, body: { nodeId: "worker-01" } });
    assert.equal(issued.response.status, 200);
    const workerToken = issued.body.token;
    const snapshot = {
      nodeId: "worker-01",
      capacity: { cpu: 1, memoryMb: 512, diskMb: 1024 },
      labels: ["test"],
      projects: ["demo"],
      metrics: { load1: 0, memoryFreeMb: 256, diskFreeMb: 512, uptimeSeconds: 1 },
      allocations: [],
      projectStates: [],
      agent: { supervised: true },
    };
    const registered = await request(baseUrl, "/api/workers/register", { token: workerToken, body: snapshot });
    assert.equal(registered.response.status, 200);
    const persistedBefore = await readFile(stateFile, "utf8");

    const status = await request(baseUrl, "/api/status", { token: adminToken });
    assert.equal(status.response.status, 200);
    assert.equal(await readFile(stateFile, "utf8"), persistedBefore);

    const heartbeat = await request(baseUrl, "/api/workers/worker-01/heartbeat", { token: workerToken, body: snapshot });
    assert.equal(heartbeat.response.status, 200);
    assert.equal(await readFile(stateFile, "utf8"), persistedBefore);
  } finally {
    controller.kill("SIGTERM");
    await new Promise((resolve) => controller.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
