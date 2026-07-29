import { createServer } from "node:http";
import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isExtensionOrigin } from "./browser-bridge.mjs";
import { AuthExpiredError, BridgeError, ConfigError, RemoteError } from "./errors.mjs";
import { createToken, verifyPassword } from "./security.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(moduleDir, "..", "web");
const lucideFile = path.resolve(moduleDir, "..", "node_modules", "lucide", "dist", "umd", "lucide.js");
const SESSION_COOKIE = "monkeycode_panel_session";

const staticFiles = new Map([
  ["/", { file: path.join(webDir, "index.html"), type: "text/html; charset=utf-8" }],
  ["/index.html", { file: path.join(webDir, "index.html"), type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: path.join(webDir, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/app.js", { file: path.join(webDir, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/vendor/lucide.js", { file: lucideFile, type: "text/javascript; charset=utf-8" }],
  ["/favicon.svg", { file: path.join(webDir, "favicon.svg"), type: "image/svg+xml" }],
]);

function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value));
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ConfigError("Request body is too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConfigError("Request body must be valid JSON");
  }
}

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function applyBridgeCors(request, response) {
  const origin = request.headers.origin;
  if (!isExtensionOrigin(origin)) return null;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin");
  return origin;
}

function clientAddress(request) {
  const forwarded = request.headers["x-real-ip"];
  if (typeof forwarded === "string" && forwarded.length <= 64) return forwarded;
  return request.socket.remoteAddress ?? "unknown";
}

export class PanelServer {
  constructor(options) {
    this.store = options.store;
    this.runner = options.runner;
    this.notifications = options.notifications;
    this.password = options.password;
    this.host = options.host;
    this.port = options.port;
    this.secureCookie = options.secureCookie;
    this.browserBridge = options.browserBridge ?? null;
    this.remoteSync = options.remoteSync ?? null;
    this.environmentKeeper = options.environmentKeeper ?? null;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.server = createServer((request, response) => this.handle(request, response));
  }

  taskSummary(task) {
    return {
      ...this.runner.taskSummary(task),
      environmentKeepAlive: this.environmentKeeper?.statusForTask(task) ?? { status: task.keepAwake ? "starting" : "off" },
    };
  }

  sessionFor(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const session = token ? this.sessions.get(token) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + 12 * 60 * 60_000;
    return { token, ...session };
  }

  requireAuth(request, response) {
    const session = this.sessionFor(request);
    if (!session) {
      json(response, 401, { error: "authentication-required" });
      return null;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers["x-csrf-token"] !== session.csrf) {
      json(response, 403, { error: "csrf-validation-failed" });
      return null;
    }
    return session;
  }

  loginAllowed(address) {
    const now = Date.now();
    const attempts = (this.loginAttempts.get(address) ?? []).filter((time) => now - time < 15 * 60_000);
    this.loginAttempts.set(address, attempts);
    return attempts.length < 8;
  }

  recordFailedLogin(address) {
    const attempts = this.loginAttempts.get(address) ?? [];
    attempts.push(Date.now());
    this.loginAttempts.set(address, attempts);
  }

  async serveStatic(pathname, response) {
    const asset = staticFiles.get(pathname);
    if (!asset) return false;
    try {
      const content = await readFile(asset.file);
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Content-Length": content.length,
        "Cache-Control": pathname.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache",
      });
      response.end(content);
    } catch {
      json(response, 404, { error: "asset-not-found" });
    }
    return true;
  }

  async handle(request, response) {
    securityHeaders(response);
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (await this.serveStatic(url.pathname, response)) return;
        json(response, 404, { error: "not-found" });
        return;
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        json(response, 200, { ok: true });
        return;
      }

      const extensionBridgeRoute = [
        "/api/browser-bridge/pair",
        "/api/browser-bridge/sync",
        "/api/browser-bridge/status",
        "/api/browser-bridge/disconnect",
      ].includes(url.pathname);
      if (extensionBridgeRoute) {
        const origin = applyBridgeCors(request, response);
        if (request.method === "OPTIONS") {
          if (!origin) throw new BridgeError("Chrome extension origin is required", 403, "extension-origin-required");
          response.writeHead(204, { "Cache-Control": "no-store" });
          response.end();
          return;
        }
        if (!origin) throw new BridgeError("Chrome extension origin is required", 403, "extension-origin-required");
        if (!this.browserBridge) throw new BridgeError("Browser bridge is disabled", 404, "browser-bridge-disabled");
        const context = {
          origin,
          address: clientAddress(request),
          authorization: request.headers.authorization,
        };
        if (url.pathname === "/api/browser-bridge/pair" && request.method === "POST") {
          json(response, 201, await this.browserBridge.pair(await readBody(request, 16 * 1024), context));
          return;
        }
        if (url.pathname === "/api/browser-bridge/sync" && request.method === "POST") {
          const result = await this.browserBridge.sync(await readBody(request, 16 * 1024), context);
          await this.environmentKeeper?.reconcile();
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/api/browser-bridge/status" && request.method === "GET") {
          json(response, 200, await this.browserBridge.status(context));
          return;
        }
        if (url.pathname === "/api/browser-bridge/disconnect" && request.method === "POST") {
          json(response, 200, await this.browserBridge.disconnect(context));
          return;
        }
        json(response, 405, { error: "method-not-allowed" });
        return;
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        const session = this.sessionFor(request);
        json(response, 200, session ? { authenticated: true, csrf: session.csrf } : { authenticated: false });
        return;
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const address = request.socket.remoteAddress ?? "unknown";
        if (!this.loginAllowed(address)) {
          json(response, 429, { error: "too-many-login-attempts" });
          return;
        }
        const body = await readBody(request, 16 * 1024);
        if (!verifyPassword(body.password, this.password)) {
          this.recordFailedLogin(address);
          json(response, 401, { error: "invalid-password" });
          return;
        }
        this.loginAttempts.delete(address);
        const token = createToken();
        const csrf = createToken(24);
        this.sessions.set(token, { csrf, expiresAt: Date.now() + 12 * 60 * 60_000 });
        const flags = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"];
        if (this.secureCookie) flags.push("Secure");
        json(response, 200, { authenticated: true, csrf }, { "Set-Cookie": flags.join("; ") });
        return;
      }

      const session = this.requireAuth(request, response);
      if (!session) return;

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        this.sessions.delete(session.token);
        const flags = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
        if (this.secureCookie) flags.push("Secure");
        json(response, 200, { ok: true }, { "Set-Cookie": flags.join("; ") });
        return;
      }

      if (url.pathname === "/api/browser-bridge/pair-code" && request.method === "POST") {
        if (!this.browserBridge) throw new ConfigError("Browser bridge is disabled");
        const body = await readBody(request, 16 * 1024);
        json(response, 201, this.browserBridge.generatePairCode(body.accountId));
        return;
      }
      const bridgeMatch = /^\/api\/browser-bridge\/([0-9a-f-]+)$/.exec(url.pathname);
      if (bridgeMatch && request.method === "DELETE") {
        if (!this.browserBridge) throw new ConfigError("Browser bridge is disabled");
        await this.store.revokeBrowserBridge(bridgeMatch[1]);
        json(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/overview" && request.method === "GET") {
        const config = this.store.getPublicConfig();
        const tasks = config.tasks.map((task) => this.taskSummary(task));
        const recentLogs = await this.store.readLogs({ limit: 1000 });
        const statsSince = Date.now() - 7 * 86_400_000;
        const completedRuns = recentLogs.filter((entry) => (
          entry.type === "task-run"
          && new Date(entry.at).getTime() >= statsSince
          && !["accepted", "dry-run", "duplicate"].includes(entry.status)
        ));
        const successfulRuns = completedRuns.filter((entry) => ["sent", "completed"].includes(entry.status));
        const failedRuns = completedRuns.filter((entry) => ["failed", "auth-expired", "completion-timeout"].includes(entry.status));
        let diskFreeGb = null;
        try {
          const disk = await statfs(this.store.dataDir);
          diskFreeGb = Math.round((Number(disk.bavail) * Number(disk.bsize) / 1024 / 1024 / 1024) * 10) / 10;
        } catch {
          // Filesystem metrics are optional on unsupported platforms.
        }
        json(response, 200, {
          enabled: config.enabled,
          updatedAt: config.updatedAt,
          accounts: config.accounts,
          tasks,
          running: this.runner.getRunning(),
          queue: this.runner.getQueue(),
          logs: recentLogs.slice(0, 8),
          runStats: {
            days: 7,
            total: completedRuns.length,
            successful: successfulRuns.length,
            failed: failedRuns.length,
            successRate: completedRuns.length ? Math.round(successfulRuns.length / completedRuns.length * 100) : null,
            lastSuccessAt: successfulRuns[0]?.at ?? null,
          },
          system: {
            node: process.version,
            uptimeSeconds: Math.round(process.uptime()),
            memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            diskFreeGb,
          },
        });
        return;
      }

      if (url.pathname === "/api/runs/queue" && request.method === "DELETE") {
        json(response, 200, await this.runner.cancelQueued());
        return;
      }

      if (url.pathname === "/api/accounts" && request.method === "GET") {
        json(response, 200, { accounts: this.store.getPublicConfig().accounts });
        return;
      }
      if (url.pathname === "/api/accounts" && request.method === "POST") {
        const account = await this.store.upsertAccount(await readBody(request, 256 * 1024));
        await this.environmentKeeper?.reconcile();
        json(response, 201, { account });
        return;
      }

      if (url.pathname === "/api/remote-sync" && request.method === "POST") {
        if (!this.remoteSync) throw new ConfigError("Remote sync is unavailable");
        json(response, 200, { results: await this.remoteSync.syncAll({ trigger: "manual" }) });
        return;
      }

      const remoteTaskMatch = /^\/api\/accounts\/([0-9a-f-]+)\/remote-tasks\/([0-9a-f-]+)$/.exec(url.pathname);
      if (remoteTaskMatch && request.method === "GET") {
        if (!this.remoteSync) throw new ConfigError("Remote sync is unavailable");
        const [, accountId, remoteTaskId] = remoteTaskMatch;
        json(response, 200, { task: await this.remoteSync.taskDetail(accountId, remoteTaskId) });
        return;
      }

      const accountMatch = /^\/api\/accounts\/([0-9a-f-]+)(?:\/(check-session|sync-remote))?$/.exec(url.pathname);
      if (accountMatch) {
        const [, accountId, action] = accountMatch;
        if (!action && request.method === "PUT") {
          const account = await this.store.upsertAccount(await readBody(request, 256 * 1024), accountId);
          await this.environmentKeeper?.reconcile();
          json(response, 200, { account });
          return;
        }
        if (!action && request.method === "DELETE") {
          await this.store.deleteAccount(accountId);
          await this.environmentKeeper?.reconcile();
          json(response, 200, { ok: true });
          return;
        }
        if (action === "check-session" && request.method === "POST") {
          const account = this.store.getAccount(accountId);
          if (!account) throw new ConfigError("Account not found");
          try {
            const user = await this.runner.checkAccountSession(accountId);
            await this.store.recordAccountValidation(accountId, "valid", user);
            await this.store.appendLog({
              type: "session-check",
              accountId,
              accountName: account.name,
              status: "valid",
              detail: "Session is valid",
            });
            json(response, 200, { valid: true, user: { id: user.id, name: user.name ?? user.nickname ?? null } });
          } catch (error) {
            await this.store.recordAccountValidation(accountId, "invalid");
            await this.store.appendLog({
              type: "session-check",
              accountId,
              accountName: account.name,
              status: "invalid",
              detail: error.message,
            });
            throw error;
          }
          return;
        }
        if (action === "sync-remote" && request.method === "POST") {
          if (!this.remoteSync) throw new ConfigError("Remote sync is unavailable");
          json(response, 200, { account: await this.remoteSync.syncAccount(accountId, { trigger: "manual" }) });
          return;
        }
      }

      if (url.pathname === "/api/tasks" && request.method === "GET") {
        json(response, 200, { tasks: this.store.getPublicConfig().tasks.map((task) => this.taskSummary(task)) });
        return;
      }
      if (url.pathname === "/api/tasks" && request.method === "POST") {
        const task = await this.store.upsertTask(await readBody(request, 2 * 1024 * 1024));
        await this.environmentKeeper?.reconcile();
        json(response, 201, { task: this.taskSummary(task) });
        return;
      }

      const taskMatch = /^\/api\/tasks\/([0-9a-f-]+)(?:\/(check-session|run|cancel|restore-prompt|clone))?$/.exec(url.pathname);
      if (taskMatch) {
        const [, taskId, action] = taskMatch;
        if (!action && request.method === "PUT") {
          if (this.runner.isPending(taskId)) throw new ConfigError("Stop the task before changing its configuration");
          const task = await this.store.upsertTask(await readBody(request, 2 * 1024 * 1024), taskId);
          await this.environmentKeeper?.reconcile();
          json(response, 200, { task: this.taskSummary(task) });
          return;
        }
        if (!action && request.method === "DELETE") {
          if (this.runner.isPending(taskId)) throw new ConfigError("Stop the task before deleting it");
          await this.store.deleteTask(taskId);
          await this.environmentKeeper?.reconcile();
          json(response, 200, { ok: true });
          return;
        }
        if (action === "check-session" && request.method === "POST") {
          const task = this.store.getTask(taskId);
          if (!task) throw new ConfigError("Task not found");
          try {
            const user = await this.runner.checkTaskSession(taskId);
            await this.store.recordAccountValidation(task.accountId, "valid", user);
            await this.store.appendLog({ type: "session-check", taskId, taskName: task.name, accountId: task.accountId, status: "valid", detail: "Session is valid" });
            json(response, 200, { valid: true, user: { id: user.id, name: user.name ?? user.nickname ?? null } });
          } catch (error) {
            if (task.accountId) await this.store.recordAccountValidation(task.accountId, "invalid");
            await this.store.appendLog({ type: "session-check", taskId, taskName: task.name, accountId: task.accountId, status: "invalid", detail: error.message });
            throw error;
          }
          return;
        }
        if (action === "run" && request.method === "POST") {
          const body = await readBody(request, 32 * 1024);
          const mode = ["dry-run", "send", "force"].includes(body.mode) ? body.mode : "send";
          const started = this.runner.start(taskId, { trigger: "manual", mode });
          json(response, started.accepted ? 202 : 409, started);
          return;
        }
        if (action === "cancel" && request.method === "POST") {
          const result = await this.runner.cancel(taskId);
          json(response, result.cancelled ? 200 : 409, result);
          return;
        }
        if (action === "restore-prompt" && request.method === "POST") {
          const body = await readBody(request, 32 * 1024);
          json(response, 200, { task: await this.store.restorePrompt(taskId, body.versionId) });
          return;
        }
        if (action === "clone" && request.method === "POST") {
          const task = await this.store.cloneTask(taskId);
          json(response, 201, { task: this.taskSummary(task) });
          return;
        }
      }

      if (url.pathname === "/api/logs" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1000);
        json(response, 200, { logs: await this.store.readLogs({
          limit,
          taskId: url.searchParams.get("taskId") || undefined,
          status: url.searchParams.get("status") || undefined,
        }) });
        return;
      }
      if (url.pathname === "/api/logs" && request.method === "DELETE") {
        await this.store.clearLogs();
        json(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/settings" && request.method === "GET") {
        const config = this.store.getPublicConfig();
        json(response, 200, {
          enabled: config.enabled,
          remoteSettings: config.remoteSettings,
          operationsSettings: config.operationsSettings,
          notifications: config.notifications,
          browserBridgeEnabled: Boolean(this.browserBridge),
        });
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "PUT") {
        const body = await readBody(request, 32 * 1024);
        if (body.enabled !== undefined) await this.store.setEnabled(body.enabled);
        if (body.remoteSettings) {
          const remoteSettings = await this.store.setRemoteSettings(body.remoteSettings);
          this.remoteSync?.configure(remoteSettings);
        }
        if (body.operationsSettings) {
          const operationsSettings = await this.store.setOperationsSettings(body.operationsSettings);
          this.runner.configure(operationsSettings);
        }
        await this.environmentKeeper?.reconcile();
        const config = this.store.getPublicConfig();
        json(response, 200, {
          enabled: config.enabled,
          remoteSettings: config.remoteSettings,
          operationsSettings: config.operationsSettings,
        });
        return;
      }
      if (url.pathname === "/api/notifications" && request.method === "POST") {
        json(response, 201, { notification: await this.store.upsertNotification(await readBody(request)) });
        return;
      }
      const notificationMatch = /^\/api\/notifications\/([0-9a-f-]+)(?:\/(test))?$/.exec(url.pathname);
      if (notificationMatch) {
        const [, notificationId, action] = notificationMatch;
        if (!action && request.method === "PUT") {
          json(response, 200, { notification: await this.store.upsertNotification(await readBody(request), notificationId) });
          return;
        }
        if (!action && request.method === "DELETE") {
          await this.store.deleteNotification(notificationId);
          json(response, 200, { ok: true });
          return;
        }
        if (action === "test" && request.method === "POST") {
          await this.notifications.test(notificationId);
          json(response, 200, { ok: true });
          return;
        }
      }

      if (url.pathname === "/api/backup/export" && request.method === "GET") {
        const payload = await this.store.exportConfig();
        json(response, 200, payload, {
          "Content-Disposition": `attachment; filename="monkeycode-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        });
        return;
      }
      if (url.pathname === "/api/backups" && request.method === "GET") {
        json(response, 200, { backups: await this.store.listBackups() });
        return;
      }
      const backupMatch = /^\/api\/backups\/(config-[A-Za-z0-9.-]+\.json)(?:\/(restore))?$/.exec(url.pathname);
      if (backupMatch) {
        const [, backupId, action] = backupMatch;
        if (!action && request.method === "GET") {
          json(response, 200, { backup: await this.store.previewBackup(backupId) });
          return;
        }
        if (action === "restore" && request.method === "POST") {
          if (this.runner.hasPending()) throw new ConfigError("Stop running and queued tasks before restoring a backup");
          const config = await this.store.restoreBackup(backupId);
          this.runner.configure(config.operationsSettings);
          this.remoteSync?.configure(config.remoteSettings);
          await this.environmentKeeper?.reconcile();
          json(response, 200, { config });
          return;
        }
      }
      if (url.pathname === "/api/backup/import" && request.method === "POST") {
        if (this.runner.hasPending()) throw new ConfigError("Stop running and queued tasks before importing a backup");
        const config = await this.store.importConfig(await readBody(request, 5 * 1024 * 1024));
        this.runner.configure(config.operationsSettings);
        this.remoteSync?.configure(config.remoteSettings);
        await this.environmentKeeper?.reconcile();
        json(response, 200, { config });
        return;
      }

      json(response, 404, { error: "not-found" });
    } catch (error) {
      if (error instanceof BridgeError) {
        json(response, error.status, { error: error.code, message: error.message });
      } else if (error instanceof AuthExpiredError) {
        json(response, 422, { error: "auth-expired", message: error.message });
      } else if (error instanceof ConfigError) {
        json(response, 400, { error: "invalid-input", message: error.message });
      } else if (error instanceof RemoteError) {
        json(response, error.status && error.status >= 400 && error.status < 600 ? error.status : 502, {
          error: "remote-error",
          message: error.message,
        });
      } else {
        console.error(error);
        json(response, 500, { error: "internal-error", message: "Internal server error" });
      }
    }
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.server.address();
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}
