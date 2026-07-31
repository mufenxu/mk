import { randomUUID } from "node:crypto";

export const WORKER_STALE_MS = 45_000;

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
  }
}

export function workerOnline(worker, now = Date.now()) {
  return worker?.status === "online" && now - new Date(worker.lastSeenAt).getTime() <= WORKER_STALE_MS;
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
  requeueExpiredLeases(state, now);
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
    return job;
  }
  return null;
}

export function publicJob(job) {
  const { leaseToken: _leaseToken, ...safe } = job;
  return safe;
}
