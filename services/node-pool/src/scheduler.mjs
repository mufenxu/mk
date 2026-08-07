import { randomUUID } from "node:crypto";

export const WORKER_STALE_MS = 45_000;

const terminalJobStatuses = new Set(["completed", "failed", "cancelled"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeCapacity(input = {}) {
  return {
    cpu: Math.max(0.1, finite(input.cpu, 1)),
    memoryMb: Math.max(128, Math.round(finite(input.memoryMb, 512))),
    diskMb: Math.max(512, Math.round(finite(input.diskMb, 1024))),
  };
}

export function normalizeRequirements(input = {}) {
  return {
    cpu: Math.max(0, finite(input.cpu, 0.25)),
    memoryMb: Math.max(0, Math.round(finite(input.memoryMb, 256))),
    labels: [...new Set((Array.isArray(input.labels) ? input.labels : []).map(String).filter(Boolean))],
  };
}

export function requeueExpiredLeases(state, now = Date.now()) {
  let changed = false;
  for (const job of state.jobs) {
    if (job.status !== "leased" || new Date(job.leaseExpiresAt).getTime() > now) continue;
    if (job.attempts >= job.maxAttempts) {
      job.status = "failed";
      job.finishedAt = new Date(now).toISOString();
      job.error = "Worker lease expired too many times";
    } else {
      job.status = "queued";
      job.assignedWorkerId = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.error = "Previous worker lease expired";
    }
    changed = true;
  }
  return changed;
}

export function pruneTerminalJobs(state, {
  now = Date.now(),
  retentionMs = 30 * 86_400_000,
  maxEntries = 1_000,
} = {}) {
  const cutoff = now - retentionMs;
  const terminal = state.jobs.filter((job) => terminalJobStatuses.has(job.status));
  const retained = terminal
    .filter((job) => {
      const finishedAt = new Date(job.finishedAt ?? "").getTime();
      return !Number.isFinite(finishedAt) || finishedAt >= cutoff;
    })
    .sort((left, right) => new Date(right.finishedAt ?? 0).getTime() - new Date(left.finishedAt ?? 0).getTime())
    .slice(0, maxEntries);
  const retainedIds = new Set(retained.map((job) => job.id));
  const jobs = state.jobs.filter((job) => !terminalJobStatuses.has(job.status) || retainedIds.has(job.id));
  if (jobs.length === state.jobs.length) return false;
  state.jobs = jobs;
  return true;
}

export function workerOnline(worker, now = Date.now()) {
  return worker?.status === "online" && now - new Date(worker.lastSeenAt).getTime() <= WORKER_STALE_MS;
}

export function summarizeState(state, now = Date.now()) {
  const workers = Object.values(state.workers ?? {});
  const online = workers.filter((worker) => workerOnline(worker, now)).length;
  const jobCounts = Object.fromEntries(["queued", "leased", "completed", "failed", "cancelled"].map((status) => [
    status,
    (state.jobs ?? []).filter((job) => job.status === status).length,
  ]));
  const oldestQueuedAt = (state.jobs ?? [])
    .filter((job) => job.status === "queued" && job.createdAt)
    .map((job) => job.createdAt)
    .sort()[0] ?? null;
  return {
    updatedAt: state.updatedAt,
    workerCounts: {
      total: workers.length,
      online,
      offline: workers.length - online,
    },
    jobCounts,
    oldestQueuedAt,
  };
}

function allocationsFor(worker, project) {
  return (worker.allocations ?? []).filter((entry) => entry.project !== project);
}

function availableCapacity(worker, project) {
  const allocations = allocationsFor(worker, project);
  return {
    cpu: worker.capacity.cpu - allocations.reduce((sum, entry) => sum + finite(entry.cpu), 0),
    memoryMb: worker.capacity.memoryMb - allocations.reduce((sum, entry) => sum + finite(entry.memoryMb), 0),
  };
}

function eligibleWorkers(state, job, now) {
  const required = job.requirements;
  return Object.values(state.workers).filter((worker) => {
    if (!workerOnline(worker, now)) return false;
    if (job.preferredWorkerId && worker.id !== job.preferredWorkerId) return false;
    if (!(worker.projects ?? []).includes(job.project)) return false;
    if (!required.labels.every((label) => worker.labels.includes(label))) return false;
    const activeJobs = state.jobs.filter((entry) => entry.status === "leased" && entry.assignedWorkerId === worker.id).length;
    if (activeJobs >= worker.maxConcurrentJobs) return false;
    const available = availableCapacity(worker, job.project);
    return available.cpu >= required.cpu && available.memoryMb >= required.memoryMb;
  });
}

function workerScore(state, worker, job, now) {
  const available = availableCapacity(worker, job.project);
  const activeJobs = state.jobs.filter((entry) => entry.status === "leased" && entry.assignedWorkerId === worker.id).length;
  const diskRatio = Math.min(1, Math.max(0, finite(worker.metrics?.diskFreeMb) / worker.capacity.diskMb));
  const idleSeconds = Math.min(600, Math.max(0, (now - new Date(worker.lastAssignedAt ?? 0).getTime()) / 1000));
  return (available.cpu / worker.capacity.cpu)
    + (available.memoryMb / worker.capacity.memoryMb)
    + diskRatio * 0.25
    + idleSeconds / 6000
    - activeJobs * 0.25;
}

export function selectWorker(state, job, now = Date.now()) {
  return eligibleWorkers(state, job, now)
    .map((worker) => ({ worker, score: workerScore(state, worker, job, now) }))
    .sort((left, right) => right.score - left.score || left.worker.id.localeCompare(right.worker.id))[0]?.worker ?? null;
}

export function claimForWorker(state, workerId, now = Date.now()) {
  const requeued = requeueExpiredLeases(state, now);
  const jobs = state.jobs
    .filter((job) => job.status === "queued")
    .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));

  for (const job of jobs) {
    const selected = selectWorker(state, job, now);
    if (selected?.id !== workerId) continue;
    job.status = "leased";
    job.assignedWorkerId = workerId;
    job.leaseToken = randomUUID();
    job.leaseExpiresAt = new Date(now + job.leaseSeconds * 1000).toISOString();
    job.attempts += 1;
    job.startedAt ??= new Date(now).toISOString();
    state.workers[workerId].lastAssignedAt = new Date(now).toISOString();
    return { job, changed: true };
  }
  return { job: null, changed: requeued };
}

export function publicJob(job) {
  const { leaseToken: _leaseToken, ...safe } = job;
  return safe;
}
