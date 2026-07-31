import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NodePoolError } from "./errors.mjs";

function parseBaseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new NodePoolError(`${name} is invalid`, 500);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new NodePoolError(`${name} is invalid`, 500);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export class NodePoolClient {
  constructor({ url, adminToken, publicUrl }) {
    if (!adminToken || adminToken.length < 24) throw new NodePoolError("MK_ADMIN_TOKEN must contain at least 24 characters", 500);
    this.url = parseBaseUrl(url, "MONKEYCODE_NODE_POOL_URL");
    this.publicUrl = parseBaseUrl(publicUrl, "MONKEYCODE_NODE_POOL_PUBLIC_URL");
    this.adminToken = adminToken;
  }

  async request(pathname, options = {}) {
    let response;
    try {
      response = await fetch(new URL(pathname, this.url), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.adminToken}`,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new NodePoolError("节点池控制器暂时不可用", 503);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw new NodePoolError("节点池管理凭证配置错误", 502);
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new NodePoolError(payload.error || `节点池请求失败（HTTP ${response.status}）`, status);
    }
    return payload;
  }

  async forwardWorkerRequest(request, response, pathname) {
    const allowed = (
      (request.method === "POST" && pathname === "/api/workers/register")
      || (request.method === "POST" && /^\/api\/workers\/[^/]+\/(heartbeat|claim)$/.test(pathname))
      || (request.method === "POST" && /^\/api\/jobs\/[^/]+\/complete$/.test(pathname))
      || (request.method === "GET" && /^\/api\/workers\/[^/]+\/bundle$/.test(pathname))
    );
    if (!allowed) throw new NodePoolError("Not found", 404);

    const hasBody = !["GET", "HEAD"].includes(request.method);
    let upstream;
    try {
      upstream = await fetch(new URL(pathname.replace(/^\//, ""), this.url), {
        method: request.method,
        headers: {
          Accept: request.headers.accept ?? "application/json",
          Authorization: request.headers.authorization ?? "",
          ...(request.headers["content-type"] ? { "Content-Type": request.headers["content-type"] } : {}),
        },
        body: hasBody ? request : undefined,
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new NodePoolError("节点池控制器暂时不可用", 503);
    }

    const headers = {};
    for (const name of ["content-type", "content-length", "content-disposition", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    if (!upstream.body) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), response);
  }

  async overview() {
    const [status, jobs] = await Promise.all([
      this.request("api/status"),
      this.request("api/jobs"),
    ]);
    return { available: true, ...status, jobs: jobs.jobs ?? [] };
  }

  createJob(body) {
    return this.request("api/jobs", { method: "POST", body });
  }

  cancelJob(jobId) {
    return this.request(`api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
  }

  async issueWorkerToken(nodeId) {
    const result = await this.request("api/workers/token", { method: "POST", body: { nodeId } });
    return {
      ...result,
      bundleUrl: new URL(`api/workers/${encodeURIComponent(result.nodeId)}/bundle`, this.publicUrl).toString(),
    };
  }
}
