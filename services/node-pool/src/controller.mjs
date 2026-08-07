import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { bearerToken, createWorkerToken, deriveWorkerToken, digestWorkerToken, secureEqual } from "./security.mjs";
import { StateStore } from "./state-store.mjs";
import {
  claimForWorker,
  normalizeCapacity,
  normalizeRequirements,
  pruneTerminalJobs,
  publicJob,
  requeueExpiredLeases,
  summarizeState,
  workerOnline,
} from "./scheduler.mjs";

const host = process.env.MK_CONTROLLER_HOST ?? "127.0.0.1";
const port = Number(process.env.MK_CONTROLLER_PORT ?? 4191);
const stateFile = process.env.MK_STATE_FILE ?? path.resolve("data/state.json");
const workerBundleFile = process.env.MK_WORKER_BUNDLE_FILE ? path.resolve(process.env.MK_WORKER_BUNDLE_FILE) : null;
const adminToken = process.env.MK_ADMIN_TOKEN ?? "";
const terminalJobRetentionMs = 30 * 86_400_000;
const maxTerminalJobs = 1_000;
const workerSecret = process.env.MK_WORKER_SECRET ?? "";
const managementUrl = process.env.MK_MANAGEMENT_URL?.trim() || null;

if (adminToken.length < 24) throw new Error("MK_ADMIN_TOKEN must contain at least 24 characters");
if (workerSecret.length < 32) throw new Error("MK_WORKER_SECRET must contain at least 32 characters");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MK_CONTROLLER_PORT");
if (managementUrl) {
  const target = new URL(managementUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid MK_MANAGEMENT_URL");
}

const store = new StateStore(stateFile);
await store.load();

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

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

async function requireWorker(request, nodeId) {
  const token = bearerToken(request);
  const authorization = await store.read((state) => ({
    credential: state.workerCredentials?.[nodeId] ?? null,
    legacyWorker: Boolean(state.workers[nodeId]),
    revoked: Boolean(state.revokedWorkers?.[nodeId]),
  }));
  if (authorization.revoked) throw httpError(401, "Worker credential has been revoked");
  const valid = authorization.credential
    ? secureEqual(digestWorkerToken(token), authorization.credential)
    : authorization.legacyWorker && secureEqual(token, deriveWorkerToken(workerSecret, nodeId));
  if (!valid) throw httpError(401, "Unauthorized");
}

function cleanNodeId(value) {
  const nodeId = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nodeId)) throw httpError(400, "Invalid worker node id");
  return nodeId;
}

function cleanLabels(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32);
}

function cleanProjects(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim())
    .filter((item) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(item)))].slice(0, 100);
}

function cleanPublicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function cleanAllocations(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((entry) => ({
    project: String(entry.project ?? "").slice(0, 80),
    cpu: Math.max(0, Number(entry.cpu) || 0),
    memoryMb: Math.max(0, Math.round(Number(entry.memoryMb) || 0)),
    pid: Number.isInteger(Number(entry.pid)) ? Number(entry.pid) : null,
    status: String(entry.status ?? "unknown").slice(0, 32),
    desiredStatus: entry.desiredStatus === "running" ? "running" : "stopped",
    port: Number.isInteger(Number(entry.port)) ? Number(entry.port) : null,
    publicUrl: cleanPublicUrl(entry.publicUrl),
  })).filter((entry) => entry.project);
}

function cleanProjectStates(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((entry) => ({
    project: String(entry.project ?? "").slice(0, 80),
    status: ["running", "stopped", "not-deployed"].includes(entry.status) ? entry.status : "stopped",
    desiredStatus: entry.desiredStatus === "running" ? "running" : "stopped",
    pid: Number.isInteger(Number(entry.pid)) ? Number(entry.pid) : null,
    port: Number.isInteger(Number(entry.port)) ? Number(entry.port) : null,
    publicUrl: cleanPublicUrl(entry.publicUrl),
    restartPolicy: entry.restartPolicy === "never" ? "never" : "unless-stopped",
    restartAttempts: Math.max(0, Math.round(Number(entry.restartAttempts) || 0)),
    nextRestartAt: entry.nextRestartAt ? String(entry.nextRestartAt).slice(0, 40) : null,
    lastRecoveredAt: entry.lastRecoveredAt ? String(entry.lastRecoveredAt).slice(0, 40) : null,
    lastError: entry.lastError ? String(entry.lastError).slice(0, 500) : null,
  })).filter((entry) => entry.project);
}

function cleanAgent(value = {}) {
  return {
    startedAt: value.startedAt ? String(value.startedAt).slice(0, 40) : null,
    supervised: value.supervised === true,
  };
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
  await requireWorker(request, nodeId);
  const now = new Date().toISOString();
  const worker = await store.mutate((state) => {
    if (state.revokedWorkers?.[nodeId]) throw httpError(401, "Worker credential has been revoked");
    const previous = state.workers[nodeId] ?? {};
    state.workers[nodeId] = {
      ...previous,
      id: nodeId,
      capacity: normalizeCapacity(body.capacity),
      labels: cleanLabels(body.labels),
      projects: cleanProjects(body.projects),
      maxConcurrentJobs: 1,
      status: "online",
      registeredAt: previous.registeredAt ?? now,
      lastSeenAt: now,
      metrics: cleanMetrics(body.metrics),
      allocations: cleanAllocations(body.allocations),
      projectStates: cleanProjectStates(body.projectStates),
      agent: cleanAgent(body.agent),
    };
    return state.workers[nodeId];
  });
  sendJson(response, 200, { worker });
}

async function heartbeatWorker(request, response, nodeId) {
  await requireWorker(request, nodeId);
  const body = await readJson(request);
  const now = Date.now();
  const result = await store.mutate((state) => {
    const current = state.workers[nodeId];
    if (!current) throw httpError(404, "Worker is not registered");
    let durableChange = false;
    if (current.status !== "online") durableChange = true;
    current.status = "online";
    current.lastSeenAt = new Date(now).toISOString();
    if (body.projects !== undefined) {
      const projects = cleanProjects(body.projects);
      if (JSON.stringify(current.projects) !== JSON.stringify(projects)) durableChange = true;
      current.projects = projects;
    }
    current.metrics = cleanMetrics(body.metrics);
    current.allocations = cleanAllocations(body.allocations);
    if (body.projectStates !== undefined) {
      const projectStates = cleanProjectStates(body.projectStates);
      if (JSON.stringify(current.projectStates) !== JSON.stringify(projectStates)) durableChange = true;
      current.projectStates = projectStates;
    }
    if (body.agent !== undefined) {
      const agent = cleanAgent(body.agent);
      if (JSON.stringify(current.agent) !== JSON.stringify(agent)) durableChange = true;
      current.agent = agent;
    }
    const active = body.activeJob;
    if (active?.jobId && active?.leaseToken) {
      const job = state.jobs.find((entry) => entry.id === active.jobId);
      if (job?.status === "leased" && job.assignedWorkerId === nodeId && secureEqual(job.leaseToken, active.leaseToken)) {
        job.leaseExpiresAt = new Date(now + job.leaseSeconds * 1000).toISOString();
        durableChange = true;
      }
    }
    return { worker: current, durableChange };
  }, { persist: (value) => value.durableChange });
  sendJson(response, 200, { worker: result.worker });
}

async function claimJob(request, response, nodeId) {
  await requireWorker(request, nodeId);
  await readJson(request);
  const result = await store.mutate((state) => {
    if (!state.workers[nodeId]) throw httpError(404, "Worker is not registered");
    state.workers[nodeId].lastSeenAt = new Date().toISOString();
    state.workers[nodeId].status = "online";
    const pruned = pruneTerminalJobs(state, { retentionMs: terminalJobRetentionMs, maxEntries: maxTerminalJobs });
    const claimed = claimForWorker(state, nodeId);
    return { ...claimed, changed: claimed.changed || pruned };
  }, { persist: (value) => value.changed });
  sendJson(response, 200, { job: result.job });
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

async function cancelJob(request, response, jobId) {
  requireAdmin(request);
  await readJson(request);
  const job = await store.mutate((state) => {
    const current = state.jobs.find((entry) => entry.id === jobId);
    if (!current) throw httpError(404, "Job not found");
    if (current.status !== "queued") throw httpError(409, "Only queued jobs can be cancelled");
    current.status = "cancelled";
    current.finishedAt = new Date().toISOString();
    return publicJob(current);
  });
  sendJson(response, 200, { job });
}

async function issueWorkerToken(request, response) {
  requireAdmin(request);
  const body = await readJson(request);
  const nodeId = cleanNodeId(body.nodeId);
  const token = createWorkerToken();
  await store.mutate((state) => {
    if (state.workers[nodeId]) throw httpError(409, "Worker node id already exists");
    state.workerCredentials ??= {};
    state.revokedWorkers ??= {};
    state.workerCredentials[nodeId] = digestWorkerToken(token);
    delete state.revokedWorkers[nodeId];
  });
  sendJson(response, 200, { nodeId, token });
}

async function deleteWorker(request, response, nodeId) {
  requireAdmin(request);
  const result = await store.mutate((state) => {
    if (!state.workers[nodeId]) throw httpError(404, "Worker not found");
    const blockingJobs = state.jobs.filter((job) => (
      (job.status === "leased" && job.assignedWorkerId === nodeId)
      || (job.status === "queued" && job.preferredWorkerId === nodeId)
    ));
    if (blockingJobs.length) throw httpError(409, "Worker still has queued or running jobs");
    delete state.workers[nodeId];
    state.workerCredentials ??= {};
    state.revokedWorkers ??= {};
    delete state.workerCredentials[nodeId];
    state.revokedWorkers[nodeId] = { revokedAt: new Date().toISOString() };
    return { nodeId, deleted: true };
  });
  sendJson(response, 200, result);
}

async function completeJob(request, response, jobId) {
  const body = await readJson(request);
  const nodeId = cleanNodeId(body.nodeId);
  await requireWorker(request, nodeId);
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
  const result = await store.mutate((current) => {
    const requeued = requeueExpiredLeases(current);
    const pruned = pruneTerminalJobs(current, { retentionMs: terminalJobRetentionMs, maxEntries: maxTerminalJobs });
    return { state: current, changed: requeued || pruned };
  }, { persist: (value) => value.changed });
  const state = result.state;
  const now = Date.now();
  const workers = Object.values(state.workers).map((worker) => ({
    ...worker,
    online: workerOnline(worker, now),
  }));
  const summary = summarizeState(state, now);
  sendJson(response, 200, { ...summary, workers });
}

async function readiness(response) {
  try {
    await store.readiness();
    const summary = summarizeState(await store.read());
    sendJson(response, 200, {
      status: "ready",
      state: {
        workerCounts: summary.workerCounts,
        jobCounts: summary.jobCounts,
        oldestQueuedAt: summary.oldestQueuedAt,
      },
    });
  } catch {
    sendJson(response, 503, { status: "unavailable", error: "state-unavailable" });
  }
}

async function sendWorkerBundle(request, response, nodeId) {
  await requireWorker(request, nodeId);
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
  securityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (["GET", "HEAD"].includes(request.method) && url.pathname === "/" && managementUrl) {
      response.writeHead(302, { Location: managementUrl, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") return await readiness(response);
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
    if (request.method === "POST" && url.pathname === "/api/workers/token") return await issueWorkerToken(request, response);
    if (request.method === "POST" && url.pathname === "/api/jobs") return await createJob(request, response);

    const workerDeletionMatch = url.pathname.match(/^\/api\/workers\/([^/]+)$/);
    if (request.method === "DELETE" && workerDeletionMatch) {
      return await deleteWorker(request, response, cleanNodeId(decodeURIComponent(workerDeletionMatch[1])));
    }

    const cancellationMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancellationMatch) return await cancelJob(request, response, cancellationMatch[1]);

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
