import { AuthExpiredError, ConfigError, RemoteError } from "./errors.mjs";
import { checkSession, getRemoteTaskDetail, runOnce } from "./client.mjs";
import { dueOccurrence, localDateKey, nextOccurrence, occurrenceKey, renderPrompt, scheduleTimes } from "./schedule.mjs";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function classifyError(error) {
  if (error instanceof AuthExpiredError) return "auth-expired";
  return "failed";
}

function retryable(error) {
  if (error instanceof AuthExpiredError || error instanceof ConfigError) return false;
  if (error instanceof RemoteError && error.status && error.status >= 400 && error.status < 500) return false;
  return true;
}

function sessionAgeDays(task, now) {
  if (!task.sessionUpdatedAt) return null;
  const updatedAt = new Date(task.sessionUpdatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return null;
  return Math.max(0, Math.floor((now.getTime() - updatedAt) / 86_400_000));
}

function sessionExpiry(task, now) {
  if (!task.sessionExpiresAt) return { expired: false, daysRemaining: null };
  const expiresAt = new Date(task.sessionExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return { expired: false, daysRemaining: null };
  const remainingMs = expiresAt - now.getTime();
  return {
    expired: remainingMs <= 0,
    daysRemaining: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
  };
}

function tokenTotal(snapshot) {
  const value = Number(snapshot?.stats?.totalTokens);
  return Number.isFinite(value) ? value : 0;
}

function snapshotChanged(before, after, acceptedAt) {
  if (!after) return false;
  if (before && after.status !== before.status) return true;
  if (before && tokenTotal(after) > tokenTotal(before)) return true;
  if (before && after.lastActiveAt && after.lastActiveAt !== before.lastActiveAt) return true;
  if (before && after.completedAt && after.completedAt !== before.completedAt) return true;
  const activity = new Date(after.completedAt ?? after.lastActiveAt ?? 0).getTime();
  return Number.isFinite(activity) && activity >= new Date(acceptedAt).getTime() - 5_000;
}

function failedResult(status) {
  return ["failed", "auth-expired", "completion-timeout"].includes(status);
}

export class TaskRunner {
  constructor(store, notifications, options = {}) {
    this.store = store;
    this.notifications = notifications;
    this.running = new Map();
    this.intervalMs = options.intervalMs ?? 30_000;
    this.remoteTaskDetail = options.remoteTaskDetail ?? getRemoteTaskDetail;
    this.wait = options.wait ?? wait;
    this.now = options.now ?? (() => Date.now());
    this.taskHealth = new Map();
    this.timer = null;
  }

  getRunning() {
    return Object.fromEntries([...this.running.entries()].map(([id, value]) => [id, {
      startedAt: value.startedAt,
      trigger: value.trigger,
      mode: value.mode,
    }]));
  }

  taskSummary(task, now = new Date()) {
    const expiry = sessionExpiry(task, now);
    return {
      ...task,
      nextRun: task.enabled ? nextOccurrence(task.schedule, now) : null,
      running: this.running.has(task.id),
      sessionAgeDays: sessionAgeDays(task, now),
      sessionExpired: expiry.expired,
      sessionDaysRemaining: expiry.daysRemaining,
      consecutiveFailures: this.taskHealth.get(task.id)?.consecutiveFailures ?? 0,
    };
  }

  async checkTaskSession(id) {
    const task = this.store.getTask(id);
    if (!task) throw new ConfigError("Task not found");
    if (!task.accountId) throw new AuthExpiredError("Account is not configured");
    return this.checkAccountSession(task.accountId);
  }

  async checkAccountSession(id) {
    const account = this.store.getAccount(id, { withSession: true });
    if (!account) throw new ConfigError("Account not found");
    if (!account.session) throw new AuthExpiredError("Session cookie is not configured");
    if (account.sessionExpiresAt && new Date(account.sessionExpiresAt).getTime() <= Date.now()) {
      throw new AuthExpiredError("Session cookie has expired");
    }
    return checkSession({
      baseUrl: new URL(account.baseUrl),
      session: account.session,
      timeoutMs: 30_000,
    });
  }

  clientConfig(task, prompt, dryRun = task.dryRun) {
    return {
      baseUrl: new URL(task.baseUrl),
      taskId: task.monkeyTaskId,
      session: task.session,
      prompt,
      timeZone: task.schedule.timeZone,
      timeoutMs: 30_000,
      historyLimit: 100,
      stateFile: this.store.taskStateFile(task.id),
      dryRun,
    };
  }

  async fetchRemoteTask(task) {
    return this.remoteTaskDetail({
      baseUrl: new URL(task.baseUrl),
      session: task.session,
      timeoutMs: 30_000,
    }, task.monkeyTaskId);
  }

  async trackCompletion(task, baseline, acceptedAt) {
    const deadline = this.now() + task.completion.timeoutMinutes * 60_000;
    let activitySeen = false;
    let lastError = null;
    while (this.now() < deadline) {
      await this.wait(task.completion.pollSeconds * 1_000);
      try {
        const snapshot = await this.fetchRemoteTask(task);
        const changed = snapshotChanged(baseline, snapshot, acceptedAt);
        if (changed && ["pending", "processing"].includes(snapshot.status)) activitySeen = true;
        if (changed || activitySeen) {
          if (snapshot.status === "finished") {
            return { status: "completed", snapshot, tokenDelta: Math.max(0, tokenTotal(snapshot) - tokenTotal(baseline)) };
          }
          if (snapshot.status === "error") {
            return { status: "failed", snapshot, detail: "MonkeyCode remote task entered the error state" };
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
    return {
      status: "completion-timeout",
      detail: lastError
        ? `Completion could not be confirmed before timeout: ${lastError.message}`
        : "Message was accepted, but completion was not observed before timeout",
    };
  }

  start(id, options = {}) {
    if (this.running.has(id)) return { accepted: false, reason: "already-running" };
    if (!this.store.getTask(id)) throw new ConfigError("Task not found");
    const info = {
      startedAt: new Date().toISOString(),
      trigger: options.trigger ?? "manual",
      mode: options.mode ?? "send",
    };
    const promise = this.execute(id, options).finally(() => this.running.delete(id));
    promise.catch((error) => {
      console.error(`Task run failed (${id}): ${error.message}`);
    });
    this.running.set(id, { ...info, promise });
    return { accepted: true, ...info };
  }

  async execute(id, options = {}) {
    const startedAt = Date.now();
    const task = this.store.getTask(id, { withSession: true });
    if (!task) throw new ConfigError("Task not found");
    const trigger = options.trigger ?? "manual";
    const mode = options.mode ?? "send";
    const now = options.now ?? new Date();
    const promptTime = options.scheduledFor ? new Date(options.scheduledFor) : now;
    const prompt = renderPrompt(task.prompt, task.name, promptTime, task.schedule.timeZone);
    const dryRun = mode === "dry-run" || (mode === "send" && task.dryRun);
    const attempts = mode === "dry-run" ? 1 : task.retry.attempts;
    let result;
    let finalError;
    let attempt = 0;
    let baseline = null;
    const runId = options.runId ?? `${task.id}:${startedAt}`;

    if (!task.session) finalError = new AuthExpiredError("Session cookie is not configured");
    else if (sessionExpiry(task, now).expired) finalError = new AuthExpiredError("Session cookie has expired");

    if (!finalError && !dryRun && task.completion?.enabled) {
      try { baseline = await this.fetchRemoteTask(task); } catch { /* Sending remains available when metadata polling is unavailable. */ }
    }

    while (!finalError && attempt < attempts) {
      attempt += 1;
      try {
        result = await runOnce(this.clientConfig(task, prompt, dryRun), {
          now,
          force: mode === "force" || task.dedupe === false,
          dedupeKey: options.occurrence?.key,
          duplicateSince: options.occurrence?.at,
        });
        break;
      } catch (error) {
        finalError = error;
        if (attempt < attempts && retryable(error)) {
          await wait(task.retry.delaySeconds * 1000);
          finalError = null;
        }
      }
    }


    if (!finalError && result?.status === "sent" && task.completion?.enabled) {
      const acceptedAt = result.acceptedAt ?? new Date().toISOString();
      await this.store.appendLog({
        type: "task-run",
        runId,
        taskId: task.id,
        taskName: task.name,
        trigger,
        mode,
        status: "accepted",
        detail: "MonkeyCode acknowledged the message; waiting for the remote task to finish",
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      });
      const completion = await this.trackCompletion(task, baseline, acceptedAt);
      result = { ...result, ...completion };
      if (completion.status === "failed") finalError = new RemoteError(completion.detail);
    }

    const status = finalError ? classifyError(finalError) : result.status;
    const detail = finalError
      ? finalError.message
      : result.status === "duplicate"
        ? `Duplicate detected by ${result.source}`
        : result.status === "dry-run"
          ? "Dry run completed without sending"
          : result.status === "completed"
            ? `MonkeyCode task completed${result.tokenDelta ? `; ${result.tokenDelta} tokens used` : ""}`
            : result.status === "completion-timeout"
              ? result.detail
              : "MonkeyCode acknowledged the message";
    const logEntry = {
      type: "task-run",
      runId,
      taskId: task.id,
      taskName: task.name,
      trigger,
      mode,
      status,
      detail,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
    };
    await this.store.appendLog(logEntry);
    await this.notifications.notify(status, { taskName: task.name, detail, at: new Date().toISOString() });
    if (finalError) throw finalError;
    return { ...result, attempts: attempt };
  }

  async finishScheduled(task, occurrence, result, error = null) {
    const state = await this.store.readScheduleState();
    const previous = state[task.id] ?? {};
    const occurrences = [...new Set([...(previous.occurrences ?? []), occurrence.key])].slice(-24);
    const status = error ? classifyError(error) : result.status;
    const consecutiveFailures = failedResult(status) ? (previous.consecutiveFailures ?? 0) + 1 : 0;
    state[task.id] = {
      ...previous,
      date: occurrence.localDate,
      occurrenceKey: occurrence.key,
      occurrences,
      status,
      consecutiveFailures,
      finishedAt: new Date().toISOString(),
    };
    await this.store.writeScheduleState(state);
    this.taskHealth.set(task.id, { consecutiveFailures });

    const threshold = task.failurePolicy?.autoPauseAfter ?? 0;
    if (threshold > 0 && consecutiveFailures >= threshold && this.store.getTask(task.id)?.enabled) {
      await this.store.setTaskEnabled(task.id, false);
      const detail = `Task was automatically paused after ${consecutiveFailures} consecutive scheduled failures`;
      await this.store.appendLog({ type: "task-policy", taskId: task.id, taskName: task.name, status: "auto-paused", detail });
      await this.notifications.notify("auto-paused", { taskName: task.name, detail, at: new Date().toISOString() });
    }
  }

  async tick(now = new Date()) {
    const config = this.store.getPublicConfig();
    if (!config.enabled) return;
    const state = await this.store.readScheduleState();

    state.__accounts ??= {};
    for (const account of config.accounts ?? []) {
      if (!account.sessionConfigured) continue;
      const previous = state.__accounts[account.id] ?? {};
      let event = null;
      let detail = null;
      let marker = null;
      if (account.sessionExpiresAt) {
        const expiry = sessionExpiry(account, now);
        event = expiry.expired ? "auth-expired" : expiry.daysRemaining <= 3 ? "session-warning" : null;
        detail = expiry.expired
          ? "Cookie has expired; sign in to MonkeyCode again to resume this account"
          : `Cookie expires in ${expiry.daysRemaining} day(s); sign in again before it expires`;
        marker = `${account.sessionUpdatedAt ?? "unknown"}:${account.sessionExpiresAt}:${event}`;
      } else {
        const credentialAge = sessionAgeDays(account, now);
        if (credentialAge >= 25) {
          event = "session-warning";
          detail = `Cookie has been stored for ${credentialAge} days; verify or update it soon`;
          marker = `${account.sessionUpdatedAt}:session-warning`;
        }
      }
      if (!event || previous.credentialNoticeFor === marker) continue;
      state.__accounts[account.id] = { ...previous, credentialNoticeFor: marker };
      await this.store.writeScheduleState(state);
      await this.store.appendLog({
        type: "session-monitor",
        accountId: account.id,
        accountName: account.name,
        status: event,
        detail,
      });
      await this.notifications.notify(event, {
        accountName: account.name,
        detail,
        at: now.toISOString(),
      });
    }

    for (const task of config.tasks.filter((item) => item.enabled)) {
      let previous = state[task.id];
      this.taskHealth.set(task.id, { consecutiveFailures: previous?.consecutiveFailures ?? 0 });
      const credentialAge = sessionAgeDays(task, now);
      if (
        !(config.accounts?.length)
        && task.sessionConfigured
        && !task.sessionExpiresAt
        && credentialAge >= 25
        && previous?.sessionWarningFor !== task.sessionUpdatedAt
      ) {
        const detail = `Cookie has been stored for ${credentialAge} days; verify or update it soon`;
        previous = { ...previous, sessionWarningFor: task.sessionUpdatedAt };
        state[task.id] = previous;
        await this.store.writeScheduleState(state);
        await this.store.appendLog({
          type: "session-warning",
          taskId: task.id,
          taskName: task.name,
          status: "session-warning",
          detail,
        });
        await this.notifications.notify("session-warning", {
          taskName: task.name,
          detail,
          at: now.toISOString(),
        });
      }
      const staleRunning = previous?.status === "running"
        && now.getTime() - new Date(previous.startedAt).getTime() > 15 * 60_000;
      let completedOccurrences = Array.isArray(previous?.occurrences) ? previous.occurrences : [];
      if (!completedOccurrences.length && previous?.date) {
        completedOccurrences = scheduleTimes(task.schedule).map((time) => occurrenceKey(previous.date, time));
      }
      if (previous?.status === "running" && previous.occurrenceKey && !staleRunning) {
        completedOccurrences = [...completedOccurrences, previous.occurrenceKey];
      }
      const occurrence = dueOccurrence(task.schedule, completedOccurrences, now);
      if (!occurrence || this.running.has(task.id)) continue;

      const date = localDateKey(now, task.schedule.timeZone);
      state[task.id] = { ...previous, date, occurrenceKey: occurrence.key, occurrences: completedOccurrences, status: "running", startedAt: now.toISOString() };
      await this.store.writeScheduleState(state);
      const started = this.start(task.id, { trigger: "schedule", mode: "send", now, scheduledFor: occurrence.at, occurrence });
      if (!started.accepted) continue;
      const running = this.running.get(task.id);
      running.promise.then(
        (result) => this.finishScheduled(task, occurrence, result),
        (error) => this.finishScheduled(task, occurrence, null, error),
      ).catch((error) => console.error(`Cannot persist scheduled task result (${task.id}): ${error.message}`));
    }
  }

  startScheduler() {
    if (this.timer) return;
    this.tick().catch((error) => console.error(`Scheduler tick failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error(`Scheduler tick failed: ${error.message}`));
    }, this.intervalMs);
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
