import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { bearerToken, deriveWorkerToken, secureEqual } from "./security.mjs";
import { StateStore } from "./state-store.mjs";
import {
  claimForWorker,
  normalizeCapacity,
  normalizeRequirements,
  publicJob,
  requeueExpiredLeases,
  workerOnline,
} from "./scheduler.mjs";

const host = process.env.MK_CONTROLLER_HOST ?? "127.0.0.1";
const port = Number(process.env.MK_CONTROLLER_PORT ?? 4190);
const stateFile = process.env.MK_STATE_FILE ?? path.resolve("data/state.json");
const workerBundleFile = process.env.MK_WORKER_BUNDLE_FILE ? path.resolve(process.env.MK_WORKER_BUNDLE_FILE) : null;
const adminToken = process.env.MK_ADMIN_TOKEN ?? "";
const workerSecret = process.env.MK_WORKER_SECRET ?? "";

if (adminToken.length < 24) throw new Error("MK_ADMIN_TOKEN must contain at least 24 characters");
if (workerSecret.length < 32) throw new Error("MK_WORKER_SECRET must contain at least 32 characters");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MK_CONTROLLER_PORT");

const store = new StateStore(stateFile);
await store.load();

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(response, statusCode, value) {
  const payload = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw httpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function requireAdmin(request) {
  if (!secureEqual(bearerToken(request), adminToken)) throw httpError(401, "Unauthorized");
}

function requireWorker(request, nodeId) {
  const expected = deriveWorkerToken(workerSecret, nodeId);
  if (!secureEqual(bearerToken(request), expected)) throw httpError(401, "Unauthorized");
}

function cleanNodeId(value) {
  const nodeId = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nodeId)) throw httpError(400, "Invalid worker node id");
  return nodeId;
}

function cleanLabels(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32);
}

function cleanAllocations(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((entry) => ({
    project: String(entry.project ?? "").slice(0, 80),
    cpu: Math.max(0, Number(entry.cpu) || 0),
    memoryMb: Math.max(0, Math.round(Number(entry.memoryMb) || 0)),
    pid: Number.isInteger(Number(entry.pid)) ? Number(entry.pid) : null,
    status: String(entry.status ?? "unknown").slice(0, 32),
    port: Number.isInteger(Number(entry.port)) ? Number(entry.port) : null,
  })).filter((entry) => entry.project);
}

function cleanMetrics(value = {}) {
  return {
    load1: Math.max(0, Number(value.load1) || 0),
    memoryFreeMb: Math.max(0, Math.round(Number(value.memoryFreeMb) || 0)),
    diskFreeMb: Math.max(0, Math.round(Number(value.diskFreeMb) || 0)),
    uptimeSeconds: Math.max(0, Math.round(Number(value.uptimeSeconds) || 0)),
  };
}

async function registerWorker(request, response) {
  const body = await readJson(request);
  const nodeId = cleanNodeId(body.nodeId);
  requireWorker(request, nodeId);
  const now = new Date().toISOString();
  const worker = await store.mutate((state) => {
    const previous = state.workers[nodeId] ?? {};
    state.workers[nodeId] = {
      ...previous,
      id: nodeId,
      capacity: normalizeCapacity(body.capacity),
      labels: cleanLabels(body.labels),
      maxConcurrentJobs: 1,
      status: "online",
      registeredAt: previous.registeredAt ?? now,
      lastSeenAt: now,
      metrics: cleanMetrics(body.metrics),
      allocations: cleanAllocations(body.allocations),
    };
    return state.workers[nodeId];
  });
  sendJson(response, 200, { worker });
}

async function heartbeatWorker(request, response, nodeId) {
  requireWorker(request, nodeId);
  const body = await readJson(request);
  const now = Date.now();
  const worker = await store.mutate((state) => {
    const current = state.workers[nodeId];
    if (!current) throw httpError(404, "Worker is not registered");
    current.status = "online";
    current.lastSeenAt = new Date(now).toISOString();
    current.metrics = cleanMetrics(body.metrics);
    current.allocations = cleanAllocations(body.allocations);
    const active = body.activeJob;
    if (active?.jobId && active?.leaseToken) {
      const job = state.jobs.find((entry) => entry.id === active.jobId);
      if (job?.status === "leased" && job.assignedWorkerId === nodeId && secureEqual(job.leaseToken, active.leaseToken)) {
        job.leaseExpiresAt = new Date(now + job.leaseSeconds * 1000).toISOString();
      }
    }
    return current;
  });
  sendJson(response, 200, { worker });
}

async function claimJob(request, response, nodeId) {
  requireWorker(request, nodeId);
  await readJson(request);
  const job = await store.mutate((state) => {
    if (!state.workers[nodeId]) throw httpError(404, "Worker is not registered");
    state.workers[nodeId].lastSeenAt = new Date().toISOString();
    state.workers[nodeId].status = "online";
    return claimForWorker(state, nodeId);
  });
  sendJson(response, 200, { job });
}

async function createJob(request, response) {
  requireAdmin(request);
  const body = await readJson(request);
  const type = String(body.type ?? "");
  if (!["deploy", "start", "stop", "restart"].includes(type)) throw httpError(400, "Unsupported job type");
  const project = String(body.project ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(project)) throw httpError(400, "Invalid project name");
  const ref = type === "deploy" ? String(body.ref ?? "main").trim() : null;
  if (ref && !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,199}$/.test(ref)) throw httpError(400, "Invalid Git ref");
  const preferredWorkerId = body.preferredWorkerId ? cleanNodeId(body.preferredWorkerId) : null;
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    type,
    project,
    ref,
    requirements: type === "stop" ? normalizeRequirements({ cpu: 0, memoryMb: 0, labels: body.requirements?.labels }) : normalizeRequirements(body.requirements),
    preferredWorkerId,
    priority: Math.min(100, Math.max(0, Math.round(Number(body.priority) || 50))),
    status: "queued",
    attempts: 0,
    maxAttempts: Math.min(5, Math.max(1, Math.round(Number(body.maxAttempts) || 2))),
    leaseSeconds: Math.min(3600, Math.max(60, Math.round(Number(body.leaseSeconds) || 900))),
    assignedWorkerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  await store.mutate((state) => state.jobs.push(job));
  sendJson(response, 201, { job: publicJob(job) });
}

async function completeJob(request, response, jobId) {
  const body = await readJson(request);
  const nodeId = cleanNodeId(body.nodeId);
  requireWorker(request, nodeId);
  const completed = await store.mutate((state) => {
    const job = state.jobs.find((entry) => entry.id === jobId);
    if (!job) throw httpError(404, "Job not found");
    if (job.status !== "leased" || job.assignedWorkerId !== nodeId || !secureEqual(job.leaseToken, body.leaseToken ?? "")) {
      throw httpError(409, "Job lease is no longer valid");
    }
    const success = body.status === "completed";
    if (!success && body.retryable === true && job.attempts < job.maxAttempts) {
      job.status = "queued";
      job.assignedWorkerId = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.error = String(body.error ?? "Worker execution failed").slice(0, 2000);
    } else {
      job.status = success ? "completed" : "failed";
      job.finishedAt = new Date().toISOString();
      job.result = success ? body.result ?? null : null;
      job.error = success ? null : String(body.error ?? "Worker execution failed").slice(0, 2000);
      job.leaseToken = null;
      job.leaseExpiresAt = null;
    }
    return publicJob(job);
  });
  sendJson(response, 200, { job: completed });
}

async function listStatus(request, response) {
  requireAdmin(request);
  const state = await store.mutate((current) => {
    requeueExpiredLeases(current);
    return current;
  });
  const now = Date.now();
  const workers = Object.values(state.workers).map((worker) => ({
    ...worker,
    online: workerOnline(worker, now),
  }));
  const jobCounts = Object.fromEntries(["queued", "leased", "completed", "failed"].map((status) => [
    status,
    state.jobs.filter((job) => job.status === status).length,
  ]));
  sendJson(response, 200, { updatedAt: state.updatedAt, workers, jobCounts });
}

async function sendWorkerBundle(request, response, nodeId) {
  requireWorker(request, nodeId);
  if (!workerBundleFile) throw httpError(404, "Worker bundle is not configured");
  let information;
  try {
    information = await stat(workerBundleFile);
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "Worker bundle is not available");
    throw error;
  }
  if (!information.isFile()) throw httpError(404, "Worker bundle is not available");
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": information.size,
    "content-disposition": "attachment; filename=monkeycode-node-pool.tar.gz",
    "cache-control": "no-store",
  });
  await pipeline(createReadStream(workerBundleFile), response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/api/status") return await listStatus(request, response);
    if (request.method === "GET" && url.pathname === "/api/workers") {
      requireAdmin(request);
      return sendJson(response, 200, { workers: Object.values((await store.read()).workers) });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      requireAdmin(request);
      return sendJson(response, 200, { jobs: (await store.read()).jobs.map(publicJob) });
    }
    if (request.method === "POST" && url.pathname === "/api/workers/register") return await registerWorker(request, response);
    if (request.method === "POST" && url.pathname === "/api/jobs") return await createJob(request, response);

    const bundleMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/bundle$/);
    if (request.method === "GET" && bundleMatch) {
      return await sendWorkerBundle(request, response, cleanNodeId(decodeURIComponent(bundleMatch[1])));
    }

    const workerMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/(heartbeat|claim)$/);
    if (request.method === "POST" && workerMatch) {
      const nodeId = cleanNodeId(decodeURIComponent(workerMatch[1]));
      return workerMatch[2] === "heartbeat"
        ? await heartbeatWorker(request, response, nodeId)
        : await claimJob(request, response, nodeId);
    }
    const completionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/complete$/);
    if (request.method === "POST" && completionMatch) return await completeJob(request, response, completionMatch[1]);
    throw httpError(404, "Not found");
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) console.error(error);
    if (response.headersSent) response.destroy();
    else sendJson(response, statusCode, { error: statusCode >= 500 ? "Internal server error" : error.message });
  }
});

export { server };

server.listen(port, host, () => {
  console.log(`MonkeyCode node-pool controller listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
