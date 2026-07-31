import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadWorkerConfig } from "./config.mjs";
import { ProjectManager } from "./process-manager.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const configPath = path.resolve(process.env.MK_WORKER_CONFIG ?? process.argv[2] ?? "worker.config.json");
const config = await loadWorkerConfig(configPath);
const token = process.env.MK_WORKER_TOKEN ?? "";
if (token.length < 32) throw new Error("MK_WORKER_TOKEN is missing or invalid");

const manager = new ProjectManager(config);
await manager.load();

let activeJob = null;
let stopping = false;
let nextReconcileAt = 0;
const startedAt = new Date().toISOString();

const startupRecoveries = await manager.reconcile();
for (const recovery of startupRecoveries) {
  if (recovery.status === "running") console.log(`Recovered project ${recovery.project} during Worker startup`);
  else console.error(`Project recovery failed for ${recovery.project}: ${recovery.error}`);
}
nextReconcileAt = Date.now() + config.reconcileIntervalSeconds * 1000;

async function requestApi(route, body) {
  const response = await fetch(`${config.controllerUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Controller returned HTTP ${response.status}: ${result.error ?? "unknown error"}`);
  return result;
}

async function metrics() {
  const disk = await statfs(config.rootDir);
  return {
    load1: os.loadavg()[0],
    memoryFreeMb: Math.round(os.freemem() / 1024 / 1024),
    diskFreeMb: Math.round((disk.bavail * disk.bsize) / 1024 / 1024),
    uptimeSeconds: Math.round(os.uptime()),
  };
}

async function nodeSnapshot() {
  await manager.refresh();
  return {
    nodeId: config.nodeId,
    capacity: config.capacity,
    labels: config.labels,
    projects: Object.keys(config.projects),
    metrics: await metrics(),
    allocations: manager.allocations(),
    projectStates: manager.projectStates(),
    agent: {
      startedAt,
      supervised: process.env.MK_WORKER_SERVICE === "1",
    },
    activeJob: activeJob ? { jobId: activeJob.id, leaseToken: activeJob.leaseToken } : null,
  };
}

async function register() {
  await requestApi("/api/workers/register", await nodeSnapshot());
  console.log(`Worker ${config.nodeId} registered with ${config.controllerUrl}`);
}

async function heartbeat() {
  await requestApi(`/api/workers/${encodeURIComponent(config.nodeId)}/heartbeat`, await nodeSnapshot());
}

async function complete(job, body) {
  await requestApi(`/api/jobs/${encodeURIComponent(job.id)}/complete`, {
    nodeId: config.nodeId,
    leaseToken: job.leaseToken,
    ...body,
  });
}

async function runLoop() {
  while (!stopping) {
    try {
      if (Date.now() >= nextReconcileAt) {
        const recoveries = await manager.reconcile();
        for (const recovery of recoveries) {
          if (recovery.status === "running") console.log(`Recovered project ${recovery.project}`);
          else console.error(`Project recovery failed for ${recovery.project}: ${recovery.error}`);
        }
        nextReconcileAt = Date.now() + config.reconcileIntervalSeconds * 1000;
      }
      const { job } = await requestApi(`/api/workers/${encodeURIComponent(config.nodeId)}/claim`, {});
      if (!job) {
        await delay(config.pollIntervalSeconds * 1000);
        continue;
      }
      activeJob = job;
      console.log(`Starting ${job.type} job ${job.id} for ${job.project}`);
      try {
        const result = await manager.execute(job);
        await complete(job, { status: "completed", result });
        console.log(`Completed job ${job.id}`);
      } catch (error) {
        await complete(job, { status: "failed", error: error.message, retryable: false });
        console.error(`Job ${job.id} failed: ${error.message}`);
      } finally {
        activeJob = null;
      }
    } catch (error) {
      console.error(`Worker loop error: ${error.message}`);
      await delay(Math.max(5000, config.pollIntervalSeconds * 1000));
    }
  }
}

while (!stopping) {
  try {
    await register();
    break;
  } catch (error) {
    console.error(`Worker registration failed: ${error.message}`);
    await delay(Math.max(5000, config.pollIntervalSeconds * 1000));
  }
}
const heartbeatTimer = setInterval(() => {
  heartbeat().catch((error) => console.error(`Heartbeat failed: ${error.message}`));
}, config.heartbeatIntervalSeconds * 1000);
heartbeatTimer.unref?.();

function shutdown() {
  stopping = true;
  clearInterval(heartbeatTimer);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await runLoop();
