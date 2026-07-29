import { AuthExpiredError, CancelledError, ConfigError, RemoteError } from "./errors.mjs";
import { checkSession, getRemoteTaskDetail, runOnce } from "./client.mjs";
import { dueOccurrence, localDateKey, nextOccurrence, occurrenceKey, renderPrompt, scheduleTimes } from "./schedule.mjs";

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CancelledError());
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function classifyError(error) {
  if (error instanceof AuthExpiredError) return "auth-expired";
  if (error instanceof CancelledError) return "cancelled";
  return "failed";
}

function retryable(error) {
  if (error instanceof AuthExpiredError || error instanceof CancelledError || error instanceof ConfigError) return false;
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
    this.queue = new Map();
    this.intervalMs = options.intervalMs ?? 30_000;
    this.remoteTaskDetail = options.remoteTaskDetail ?? getRemoteTaskDetail;
    this.wait = options.wait ?? wait;
    this.now = options.now ?? (() => Date.now());
    this.taskHealth = new Map();
    this.accountConcurrency = options.accountConcurrency
      ?? store.getPublicConfig?.().operationsSettings?.accountConcurrency
      ?? 1;
    this.timer = null;
  }

  getRunning() {
    return Object.fromEntries([...this.running.entries()].map(([id, value]) => [id, {
      startedAt: value.startedAt,
      trigger: value.trigger,
      mode: value.mode,
    }]));
  }

  getQueue() {
    const positions = new Map();
    return [...this.queue.values()].map((job) => {
      const accountId = this.accountKey(job.task);
      const position = (positions.get(accountId) ?? 0) + 1;
      positions.set(accountId, position);
      return {
        taskId: job.task.id,
        taskName: job.task.name,
        accountId: job.task.accountId,
        accountName: job.task.accountName ?? null,
        queuedAt: job.queuedAt,
        trigger: job.options.trigger ?? "manual",
        mode: job.options.mode ?? "send",
        position,
      };
    });
  }

  hasPending() {
    return this.running.size > 0 || this.queue.size > 0;
  }

  isPending(id) {
    return this.running.has(id) || this.queue.has(id);
  }

  getPendingPromise(id) {
    return this.running.get(id)?.promise ?? this.queue.get(id)?.promise ?? null;
  }

  configure(settings = {}) {
    const concurrency = Number(settings.accountConcurrency);
    if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 5) {
      this.accountConcurrency = concurrency;
      for (const accountId of new Set([...this.queue.values()].map((job) => this.accountKey(job.task)))) {
        this.drain(accountId);
      }
    }
  }

  taskSummary(task, now = new Date()) {
    const expiry = sessionExpiry(task, now);
    return {
      ...task,
      nextRun: task.enabled ? nextOccurrence(task.schedule, now) : null,
      running: this.running.has(task.id),
      queued: this.queue.has(task.id),
      queuePosition: this.getQueue().find((entry) => entry.taskId === task.id)?.position ?? null,
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

  clientConfig(task, prompt, dryRun = task.dryRun, signal) {
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
      signal,
    };
  }

  async fetchRemoteTask(task, signal) {
    return this.remoteTaskDetail({
      baseUrl: new URL(task.baseUrl),
      session: task.session,
      timeoutMs: 30_000,
      signal,
    }, task.monkeyTaskId);
  }

  async trackCompletion(task, baseline, acceptedAt, signal) {
    const deadline = this.now() + task.completion.timeoutMinutes * 60_000;
    let activitySeen = false;
    let lastError = null;
    while (this.now() < deadline) {
      await this.wait(task.completion.pollSeconds * 1_000, signal);
      if (signal?.aborted) throw new CancelledError();
      try {
        const snapshot = await this.fetchRemoteTask(task, signal);
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
    if (this.running.has(id) || this.queue.has(id)) return { accepted: false, reason: "already-pending" };
    const task = this.store.getTask(id);
    if (!task) throw new ConfigError("Task not found");
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    promise.catch((error) => {
      if (!(error instanceof CancelledError)) console.error(`Task run failed (${id}): ${error.message}`);
    });
    const job = {
      task,
      options,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    };
    if (this.canStart(task)) this.launch(job);
    else this.queue.set(id, job);
    return {
      accepted: true,
      queued: this.queue.has(id),
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      trigger: options.trigger ?? "manual",
      mode: options.mode ?? "send",
    };
  }

  accountKey(task) {
    return task.accountId ?? `task:${task.id}`;
  }

  activeCount(task) {
    const accountId = this.accountKey(task);
    return [...this.running.values()].filter((job) => this.accountKey(job.task) === accountId).length;
  }

  canStart(task) {
    return this.activeCount(task) < this.accountConcurrency;
  }

  launch(job) {
    this.queue.delete(job.task.id);
    job.startedAt = new Date().toISOString();
    this.running.set(job.task.id, job);
    Promise.resolve()
      .then(() => this.execute(job.task.id, { ...job.options, signal: job.controller.signal }))
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running.delete(job.task.id);
        this.drain(this.accountKey(job.task));
      });
  }

  drain(accountId) {
    while ([...this.running.values()].filter((job) => this.accountKey(job.task) === accountId).length < this.accountConcurrency) {
      const next = [...this.queue.values()].find((job) => this.accountKey(job.task) === accountId);
      if (!next) break;
      this.launch(next);
    }
  }

  async cancel(id) {
    const queued = this.queue.get(id);
    if (queued) {
      this.queue.delete(id);
      const detail = "Task run was cancelled while waiting in the account queue";
      const result = { status: "cancelled", detail, attempts: 0 };
      await this.store.appendLog({
        type: "task-run",
        taskId: queued.task.id,
        taskName: queued.task.name,
        trigger: queued.options.trigger ?? "manual",
        mode: queued.options.mode ?? "send",
        status: "cancelled",
        detail,
        attempts: 0,
        durationMs: Date.now() - new Date(queued.queuedAt).getTime(),
      });
      queued.resolve(result);
      return { cancelled: true, state: "queued" };
    }
    const running = this.running.get(id);
    if (running && !running.controller.signal.aborted) {
      running.controller.abort();
      return { cancelled: true, state: "running" };
    }
    return { cancelled: false, reason: "not-pending" };
  }

  async cancelQueued() {
    const taskIds = [...this.queue.keys()];
    for (const taskId of taskIds) await this.cancel(taskId);
    return { cancelled: taskIds.length };
  }

  quotaBlock(task, mode) {
    if (mode === "force" || mode === "dry-run") return null;
    const settings = this.store.getPublicConfig().remoteSettings ?? {};
    if (!settings.quotaGuardEnabled) return null;
    const account = this.store.getAccount(task.accountId);
    const balance = Number(account?.remoteSnapshot?.wallet?.dailyTokenBalance);
    const limit = Number(account?.remoteSnapshot?.wallet?.dailyTokenLimit);
    if (!Number.isFinite(balance) || !Number.isFinite(limit) || limit <= 0) {
      return "Quota protection blocked the run because no valid synchronized quota is available";
    }
    const remainingPercent = balance / limit * 100;
    if (balance <= settings.quotaReserveTokens || remainingPercent <= settings.quotaReservePercent) {
      return `Quota protection kept the configured reserve (${Math.max(0, Math.round(balance)).toLocaleString("en-US")} tokens, ${Math.max(0, remainingPercent).toFixed(1)}% remaining)`;
    }
    return null;
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
    const signal = options.signal;
    let result;
    let finalError;
    let attempt = 0;
    let baseline = null;
    const runId = options.runId ?? `${task.id}:${startedAt}`;

    if (signal?.aborted) finalError = new CancelledError();
    else if (!task.session) finalError = new AuthExpiredError("Session cookie is not configured");
    else if (sessionExpiry(task, now).expired) finalError = new AuthExpiredError("Session cookie has expired");

    const quotaBlock = !finalError && !dryRun ? this.quotaBlock(task, mode) : null;
    if (quotaBlock) result = { status: "quota-blocked", detail: quotaBlock };

    if (!finalError && !result && !dryRun && task.completion?.enabled) {
      try { baseline = await this.fetchRemoteTask(task, signal); } catch (error) {
        if (error instanceof CancelledError) finalError = error;
        // Sending remains available when metadata polling is unavailable.
      }
    }

    while (!finalError && !result && attempt < attempts) {
      attempt += 1;
      try {
        result = await runOnce(this.clientConfig(task, prompt, dryRun, signal), {
          now,
          force: mode === "force" || task.dedupe === false,
          dedupeKey: options.occurrence?.key,
          duplicateSince: options.occurrence?.at,
        });
        break;
      } catch (error) {
        finalError = error;
        if (attempt < attempts && retryable(error)) {
          try {
            await this.wait(task.retry.delaySeconds * 1000, signal);
            finalError = null;
          } catch (waitError) {
            finalError = waitError;
          }
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
      try {
        const completion = await this.trackCompletion(task, baseline, acceptedAt, signal);
        result = { ...result, ...completion };
        if (completion.status === "failed") finalError = new RemoteError(completion.detail);
      } catch (error) {
        finalError = error;
      }
    }

    const status = finalError ? classifyError(finalError) : result.status;
    const detail = finalError
      ? finalError.message
      : result.status === "quota-blocked"
        ? result.detail
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
    await this.notifications.notify(status === "quota-blocked" ? "quota-low" : status, {
      taskName: task.name,
      detail,
      at: new Date().toISOString(),
    });
    if (finalError && !(finalError instanceof CancelledError)) throw finalError;
    return { ...result, status, detail, attempts: attempt };
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
      const pendingStatus = ["running", "queued"].includes(previous?.status);
      const pendingSince = previous?.startedAt ?? previous?.queuedAt;
      const staleRunning = pendingStatus
        && now.getTime() - new Date(pendingSince).getTime() > 15 * 60_000;
      let completedOccurrences = Array.isArray(previous?.occurrences) ? previous.occurrences : [];
      if (!completedOccurrences.length && previous?.date) {
        completedOccurrences = scheduleTimes(task.schedule).map((time) => occurrenceKey(previous.date, time));
      }
      if (pendingStatus && previous.occurrenceKey && !staleRunning) {
        completedOccurrences = [...completedOccurrences, previous.occurrenceKey];
      }
      const occurrence = dueOccurrence(task.schedule, completedOccurrences, now);
      if (!occurrence || this.running.has(task.id) || this.queue.has(task.id)) continue;

      const date = localDateKey(now, task.schedule.timeZone);
      const started = this.start(task.id, { trigger: "schedule", mode: "send", now, scheduledFor: occurrence.at, occurrence });
      if (!started.accepted) continue;
      state[task.id] = {
        ...previous,
        date,
        occurrenceKey: occurrence.key,
        occurrences: completedOccurrences,
        status: started.queued ? "queued" : "running",
        queuedAt: started.queuedAt,
        startedAt: started.startedAt,
      };
      await this.store.writeScheduleState(state);
      const pending = this.getPendingPromise(task.id);
      pending.then(
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
