import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectManager } from "./process-manager.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanConfig(config) {
  if (config?.version !== 1) throw new Error("Unsupported worker config version");
  const nodeId = String(config.nodeId ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nodeId)) throw new Error("Invalid worker node id");
  const controllerUrl = new URL(config.controllerUrl);
  if (!["http:", "https:"].includes(controllerUrl.protocol)) throw new Error("Controller URL must use HTTP or HTTPS");
  if (!config.rootDir || !path.isAbsolute(config.rootDir)) throw new Error("Worker rootDir must be an absolute path");
  if (!config.projects || typeof config.projects !== "object") throw new Error("Worker projects must be an object");
  for (const [name, project] of Object.entries(config.projects)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(name)) throw new Error(`Invalid project name: ${name}`);
    if (!project.repo || !project.start) throw new Error(`Project ${name} requires repo and start fields`);
  }
  return {
    ...config,
    nodeId,
    controllerUrl: controllerUrl.toString().replace(/\/$/, ""),
    capacity: {
      cpu: Math.max(0.1, Number(config.capacity?.cpu) || 1),
      memoryMb: Math.max(128, Math.round(Number(config.capacity?.memoryMb) || 512)),
      diskMb: Math.max(512, Math.round(Number(config.capacity?.diskMb) || 1024)),
    },
    labels: [...new Set((Array.isArray(config.labels) ? config.labels : []).map(String).filter(Boolean))],
    pollIntervalSeconds: Math.max(1, Number(config.pollIntervalSeconds) || 5),
    heartbeatIntervalSeconds: Math.max(5, Number(config.heartbeatIntervalSeconds) || 15),
  };
}

const configPath = path.resolve(process.env.MK_WORKER_CONFIG ?? process.argv[2] ?? "worker.config.json");
const config = cleanConfig(JSON.parse(await readFile(configPath, "utf8")));
const token = process.env.MK_WORKER_TOKEN ?? "";
if (token.length < 32) throw new Error("MK_WORKER_TOKEN is missing or invalid");

const manager = new ProjectManager(config);
await manager.load();

let activeJob = null;
let stopping = false;

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
    metrics: await metrics(),
    allocations: manager.allocations(),
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

await register();
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
