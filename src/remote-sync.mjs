import { AuthExpiredError, ConfigError } from "./errors.mjs";
import { getRemoteAccountSnapshot, getRemoteTaskDetail } from "./client.mjs";

function accountClientConfig(account, timeoutMs) {
  if (!account) throw new ConfigError("Account not found");
  if (!account.session) throw new AuthExpiredError("Session cookie is not configured");
  return {
    baseUrl: new URL(account.baseUrl),
    session: account.session,
    timeoutMs,
  };
}

function quotaAlert(wallet, warningPercent) {
  const balance = Number(wallet?.dailyTokenBalance);
  const limit = Number(wallet?.dailyTokenLimit);
  if (!Number.isFinite(balance) || !Number.isFinite(limit) || limit <= 0) return null;
  const ratio = balance / limit;
  if (ratio > warningPercent / 100) return null;
  const threshold = ratio <= 0.05 ? 5 : ratio <= 0.1 ? 10 : warningPercent;
  return {
    id: `quota-low-${threshold}`,
    kind: "quota-low",
    severity: threshold <= 5 ? "critical" : "warning",
    title: `每日额度剩余不足 ${threshold}%`,
    detail: `当前剩余 ${Math.max(0, Math.round(balance)).toLocaleString("zh-CN")} / ${Math.round(limit).toLocaleString("zh-CN")}`,
  };
}

function snapshotAlerts(account, snapshot, configuredTasks, quotaWarningPercent) {
  const alerts = [];
  if (snapshot.profile?.isBlocked || snapshot.profile?.status === "blocked") {
    alerts.push({ id: "account-blocked", kind: "sync-failed", severity: "critical", title: "MonkeyCode 账号已被限制", detail: "请先在 MonkeyCode 官网处理账号状态。" });
  }
  const quota = quotaAlert(snapshot.wallet, quotaWarningPercent);
  if (quota) alerts.push(quota);

  const remoteById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const localTask of configuredTasks) {
    const remoteTask = remoteById.get(localTask.monkeyTaskId);
    if (!remoteTask) {
      alerts.push({
        id: `task-missing-${localTask.id}`,
        kind: "remote-task-missing",
        severity: "warning",
        title: `远端任务“${localTask.name}”未找到`,
        detail: `任务 ID ${localTask.monkeyTaskId} 不在本次同步结果中。`,
        taskId: localTask.id,
      });
      continue;
    }
    if (remoteTask.status === "error") {
      alerts.push({
        id: `task-error-${localTask.id}`,
        kind: "remote-task-error",
        severity: "critical",
        title: `远端任务“${remoteTask.name}”异常`,
        detail: "MonkeyCode 返回任务状态 error。",
        taskId: localTask.id,
        remoteTaskId: remoteTask.id,
      });
    }
    if (remoteTask.environment?.state === "hibernated") {
      alerts.push({
        id: `environment-hibernated-${localTask.id}`,
        kind: "environment-hibernated",
        severity: "info",
        title: `“${remoteTask.name}”的环境已休眠`,
        detail: "环境将在下次访问或发送消息时由 MonkeyCode 恢复。",
        taskId: localTask.id,
        remoteTaskId: remoteTask.id,
      });
    }
  }
  return alerts;
}

export class RemoteSyncService {
  constructor(store, notifications, options = {}) {
    this.store = store;
    this.notifications = notifications;
    const settings = store.getPublicConfig().remoteSettings;
    this.enabled = settings?.enabled !== false;
    this.intervalMs = options.intervalMs ?? (settings?.intervalMinutes ?? 10) * 60_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.timer = null;
    this.initialTimer = null;
    this.running = new Map();
    this.runningAll = null;
  }

  async syncAccount(id, options = {}) {
    if (this.running.has(id)) return this.running.get(id);
    const promise = this.#syncAccount(id, options).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  async #syncAccount(id, options) {
    const before = this.store.getAccount(id);
    const account = this.store.getAccount(id, { withSession: true });
    const previousAlerts = new Set((before?.remoteSnapshot?.alerts ?? []).map((alert) => alert.id));
    try {
      const snapshot = await getRemoteAccountSnapshot(accountClientConfig(account, this.timeoutMs));
      const configuredTasks = this.store.getPublicConfig().tasks.filter((task) => task.accountId === id);
      const settings = this.store.getPublicConfig().remoteSettings;
      snapshot.alerts = snapshotAlerts(account, snapshot, configuredTasks, settings?.quotaWarningPercent ?? 20);
      snapshot.syncedAt = new Date().toISOString();
      const updated = await this.store.recordRemoteSync(id, snapshot);
      await this.store.appendLog({
        type: "remote-sync",
        accountId: id,
        accountName: updated.name,
        status: "synced",
        trigger: options.trigger ?? "manual",
        detail: `已同步 ${snapshot.tasks.length} 个远端任务`,
      });
      for (const alert of snapshot.alerts.filter((item) => !previousAlerts.has(item.id))) {
        await this.notifications.notify(alert.kind, {
          accountName: updated.name,
          taskName: alert.title,
          detail: alert.detail,
          at: snapshot.syncedAt,
        });
      }
      return updated;
    } catch (error) {
      const firstFailure = before?.remoteSyncStatus !== "error";
      if (error instanceof AuthExpiredError) await this.store.recordAccountValidation(id, "invalid");
      const updated = await this.store.recordRemoteSyncFailure(id, error.message);
      const status = error instanceof AuthExpiredError ? "auth-expired" : "failed";
      await this.store.appendLog({
        type: "remote-sync",
        accountId: id,
        accountName: updated.name,
        status,
        trigger: options.trigger ?? "manual",
        detail: error.message,
      });
      if (firstFailure) {
        await this.notifications.notify("sync-failed", {
          accountName: updated.name,
          detail: error.message,
          at: new Date().toISOString(),
        });
      }
      throw error;
    }
  }

  async taskDetail(accountId, taskId) {
    const account = this.store.getAccount(accountId, { withSession: true });
    return getRemoteTaskDetail(accountClientConfig(account, this.timeoutMs), taskId);
  }

  async syncAll(options = {}) {
    if (this.runningAll) return this.runningAll;
    this.runningAll = (async () => {
      const results = [];
      const accounts = this.store.getPublicConfig().accounts.filter((account) => account.sessionConfigured);
      for (const account of accounts) {
        try {
          results.push({ accountId: account.id, ok: true, account: await this.syncAccount(account.id, options) });
        } catch (error) {
          results.push({ accountId: account.id, ok: false, error: error.message });
        }
      }
      return results;
    })().finally(() => { this.runningAll = null; });
    return this.runningAll;
  }

  start() {
    if (this.timer || !this.enabled || this.intervalMs <= 0) return;
    const run = () => this.syncAll({ trigger: "schedule" }).catch((error) => {
      console.error(`Remote sync failed: ${error.message}`);
    });
    this.initialTimer = setTimeout(run, 2_000);
    this.initialTimer.unref?.();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  configure(settings = {}) {
    this.stop();
    this.enabled = settings.enabled !== false;
    this.intervalMs = Math.max(1, Number(settings.intervalMinutes) || 10) * 60_000;
    this.start();
  }
}
