import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:4190");
const adminToken = process.env.SMOKE_ADMIN_TOKEN ?? "";
assert.ok(adminToken.length >= 24, "SMOKE_ADMIN_TOKEN is required");

async function request(pathname, { token = adminToken, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

const ready = await request("/readyz", { token: null });
assert.equal(ready.response.status, 200);
assert.equal(ready.payload.status, "ready");

const issued = await request("/api/workers/token", { body: { nodeId: "smoke-worker" } });
assert.equal(issued.response.status, 200);
const workerToken = issued.payload.token;
assert.ok(workerToken?.length >= 32);

const worker = {
  nodeId: "smoke-worker",
  capacity: { cpu: 1, memoryMb: 512, diskMb: 1024 },
  labels: ["smoke"],
  projects: ["smoke-project"],
  metrics: { load1: 0, memoryFreeMb: 512, diskFreeMb: 1024, uptimeSeconds: 1 },
  allocations: [],
  projectStates: [],
  agent: { supervised: true },
};
const registered = await request("/api/workers/register", { token: workerToken, body: worker });
assert.equal(registered.response.status, 200);

const created = await request("/api/jobs", {
  body: { type: "start", project: "smoke-project", requirements: { labels: ["smoke"] } },
});
assert.equal(created.response.status, 201);

const claimed = await request("/api/workers/smoke-worker/claim", { token: workerToken, body: {} });
assert.equal(claimed.response.status, 200);
assert.equal(claimed.payload.job.id, created.payload.job.id);

const completed = await request(`/api/jobs/${encodeURIComponent(claimed.payload.job.id)}/complete`, {
  token: workerToken,
  body: {
    nodeId: "smoke-worker",
    leaseToken: claimed.payload.job.leaseToken,
    status: "completed",
    result: { smoke: true },
  },
});
assert.equal(completed.response.status, 200);
assert.equal(completed.payload.job.status, "completed");

const status = await request("/api/status");
assert.equal(status.response.status, 200);
assert.equal(status.payload.workerCounts.online, 1);
assert.equal(status.payload.jobCounts.completed, 1);

console.log("Node-pool controller smoke flow passed");
