import { createHash } from "node:crypto";

import WebSocket from "ws";

import { cookieHeader } from "./protocol.mjs";

const USER_AGENT = "Mozilla/5.0 MonkeyCode-VPS-Keeper/1.0";

function controlUrl(baseUrl, taskId) {
  const url = new URL("/api/v1/users/tasks/control", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("id", taskId);
  return url;
}

function connectionFingerprint(spec) {
  return createHash("sha256")
    .update(`${spec.baseUrl}\n${spec.monkeyTaskId}\n${spec.session}`, "utf8")
    .digest("hex");
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

export class EnvironmentKeeper {
  constructor(store, options = {}) {
    this.store = store;
    this.WebSocket = options.WebSocket ?? WebSocket;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 30_000;
    this.staleAfterMs = options.staleAfterMs ?? 45_000;
    this.staleCheckMs = options.staleCheckMs ?? 10_000;
    this.reconnectDelays = options.reconnectDelays ?? [1_000, 5_000, 15_000, 30_000, 60_000];
    this.handshakeTimeout = options.handshakeTimeout ?? 15_000;
    this.entries = new Map();
    this.taskToKey = new Map();
    this.globalEnabled = true;
    this.started = false;
    this.timer = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.reconcile();
    this.timer = setInterval(() => {
      this.reconcile().catch((error) => console.error(`Environment keeper reconcile failed: ${safeError(error)}`));
    }, this.reconcileIntervalMs);
    this.timer.unref?.();
  }

  async reconcile() {
    const config = this.store.getPublicConfig();
    this.globalEnabled = config.enabled;
    const desired = new Map();

    if (this.started && config.enabled) {
      for (const publicTask of config.tasks) {
        if (!publicTask.keepAwake || !publicTask.accountId) continue;
        const task = this.store.getTask(publicTask.id, { withSession: true });
        if (!task?.session || !task.baseUrl) continue;
        const key = `${task.accountId}:${task.monkeyTaskId}`;
        const spec = desired.get(key) ?? {
          key,
          accountId: task.accountId,
          baseUrl: task.baseUrl,
          monkeyTaskId: task.monkeyTaskId,
          session: task.session,
          taskIds: new Set(),
        };
        spec.taskIds.add(task.id);
        desired.set(key, spec);
      }
    }

    this.taskToKey.clear();
    for (const [key, entry] of [...this.entries]) {
      const spec = desired.get(key);
      if (!spec || entry.fingerprint !== connectionFingerprint(spec)) {
        this.stopEntry(entry);
        this.entries.delete(key);
      }
    }

    for (const [key, spec] of desired) {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = this.createEntry(spec);
        this.entries.set(key, entry);
        this.connect(entry);
      } else {
        entry.taskIds = spec.taskIds;
      }
      for (const taskId of spec.taskIds) this.taskToKey.set(taskId, key);
    }
  }

  createEntry(spec) {
    return {
      ...spec,
      fingerprint: connectionFingerprint(spec),
      status: "connecting",
      ws: null,
      attempt: 0,
      connectedAt: null,
      lastPingAt: null,
      lastMessageAt: null,
      lastError: null,
      nextRetryAt: null,
      retryTimer: null,
      staleTimer: null,
      stopped: false,
      authFailed: false,
    };
  }

  connect(entry) {
    if (entry.stopped || entry.authFailed || !this.started) return;
    entry.status = entry.attempt > 0 ? "reconnecting" : "connecting";
    entry.nextRetryAt = null;

    const url = controlUrl(entry.baseUrl, entry.monkeyTaskId);
    const ws = new this.WebSocket(url, {
      headers: {
        Cookie: cookieHeader(entry.session),
        Origin: new URL(entry.baseUrl).origin,
        "User-Agent": USER_AGENT,
      },
      handshakeTimeout: this.handshakeTimeout,
    });
    entry.ws = ws;

    ws.on("open", () => {
      if (entry.stopped || entry.ws !== ws) return;
      const now = new Date().toISOString();
      entry.status = "connected";
      entry.attempt = 0;
      entry.connectedAt = now;
      entry.lastMessageAt = now;
      entry.lastError = null;
      entry.staleTimer = setInterval(() => {
        if (entry.ws !== ws || ws.readyState !== this.WebSocket.OPEN) return;
        const lastMessage = new Date(entry.lastMessageAt).getTime();
        if (Number.isFinite(lastMessage) && Date.now() - lastMessage > this.staleAfterMs) {
          entry.lastError = "MonkeyCode control channel heartbeat timed out";
          ws.terminate();
        }
      }, this.staleCheckMs);
      entry.staleTimer.unref?.();
    });

    ws.on("message", (data) => {
      if (entry.stopped || entry.ws !== ws) return;
      const now = new Date().toISOString();
      entry.lastMessageAt = now;
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === "ping") entry.lastPingAt = now;
      } catch {
        // Future server messages still prove that the control channel is alive.
      }
    });

    ws.on("unexpected-response", (_request, response) => {
      if (entry.stopped || entry.ws !== ws) return;
      const status = Number(response.statusCode);
      entry.lastError = `MonkeyCode control channel returned HTTP ${status || "unknown"}`;
      if ([401, 403].includes(status) || (status >= 300 && status < 400)) {
        entry.authFailed = true;
        entry.status = "auth-expired";
      }
      response.resume();
      try { ws.terminate(); } catch { /* The failed handshake may already be closed. */ }
    });

    ws.on("error", (error) => {
      if (!entry.stopped && entry.ws === ws && !entry.authFailed) entry.lastError = safeError(error);
    });

    ws.on("close", () => {
      if (entry.ws !== ws) return;
      clearInterval(entry.staleTimer);
      entry.staleTimer = null;
      entry.ws = null;
      if (!entry.stopped && !entry.authFailed) this.scheduleReconnect(entry);
    });
  }

  scheduleReconnect(entry) {
    const index = Math.min(entry.attempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index];
    entry.attempt += 1;
    entry.status = "reconnecting";
    entry.nextRetryAt = new Date(Date.now() + delay).toISOString();
    clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => this.connect(entry), delay);
    entry.retryTimer.unref?.();
  }

  statusForTask(task) {
    if (!task.keepAwake) return { status: "off" };
    if (!this.globalEnabled) return { status: "paused" };
    const key = this.taskToKey.get(task.id);
    const entry = key ? this.entries.get(key) : null;
    if (!entry) {
      const invalidCredential = ["missing", "expired", "invalid"].includes(task.accountCredentialStatus);
      return { status: invalidCredential ? "auth-expired" : "starting" };
    }
    return {
      status: entry.status,
      connectedAt: entry.connectedAt,
      lastPingAt: entry.lastPingAt,
      lastError: entry.lastError,
      nextRetryAt: entry.nextRetryAt,
      sharedTaskCount: entry.taskIds.size,
    };
  }

  stopEntry(entry) {
    entry.stopped = true;
    clearTimeout(entry.retryTimer);
    clearInterval(entry.staleTimer);
    entry.retryTimer = null;
    entry.staleTimer = null;
    const ws = entry.ws;
    entry.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === this.WebSocket.OPEN) ws.close(1000, "keeper stopped");
      else ws.terminate();
    } catch {
      // Shutdown is best effort.
    }
  }

  stop() {
    this.started = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
    this.taskToKey.clear();
  }
}
