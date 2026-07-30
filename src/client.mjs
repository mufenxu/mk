import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import WebSocket from "ws";

import { AuthExpiredError, CancelledError, RemoteError } from "./errors.mjs";
import {
  cookieHeader,
  dayKey,
  encodeUserInput,
  extractHistoryItems,
  isDuplicateHistory,
  makeStreamUrl,
  promptHash,
} from "./protocol.mjs";

const USER_AGENT = "monkeycode-daily-sender/1.0";

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

async function requestJson(config, pathname, searchParams, options = {}) {
  const url = new URL(pathname, config.baseUrl);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader(config.session),
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal: requestSignal(config.signal, config.timeoutMs),
    });
  } catch (error) {
    if (config.signal?.aborted) throw new CancelledError();
    throw new RemoteError(`Request failed for ${url.pathname}: ${error.message}`);
  }

  if (options.unavailableStatuses?.includes(response.status)) return null;
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new AuthExpiredError();
  }
  if (!response.ok) {
    throw new RemoteError(`MonkeyCode returned HTTP ${response.status} for ${url.pathname}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new RemoteError(`MonkeyCode returned invalid JSON for ${url.pathname}`, response.status);
  }
}

function responseData(body, operation) {
  const error = responseError(body, operation);
  if (error) throw error;
  return body?.data ?? body;
}

function cleanRemoteTime(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const time = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp);
    return Number.isFinite(time.getTime()) ? time.toISOString() : null;
  }
  if (typeof value !== "string" || !value || value.startsWith("0001-01-01")) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function cleanTransitionTime(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const time = new Date(milliseconds);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function remoteTaskName(task) {
  const title = typeof task?.title === "string" ? task.title.trim() : "";
  const summary = typeof task?.summary === "string" ? task.summary.trim() : "";
  const content = typeof task?.content === "string" ? task.content.trim().replace(/\s+/g, " ") : "";
  return title || summary || (content ? `${Array.from(content).slice(0, 48).join("")}${Array.from(content).length > 48 ? "..." : ""}` : "") || String(task?.id ?? "Unknown task");
}

function remoteModel(model) {
  if (!model) return null;
  if (typeof model === "string") return { id: model, name: model };
  return {
    id: model.id ? String(model.id) : null,
    name: model.model ? String(model.model) : model.id ? String(model.id) : null,
    provider: model.provider ? String(model.provider) : null,
    owner: model.owner ? String(model.owner) : null,
    contextLimit: finiteNumber(model.context_limit, null),
    outputLimit: finiteNumber(model.output_limit, null),
    thinkingEnabled: Boolean(model.thinking_enabled),
    supportImage: Boolean(model.support_image),
  };
}

function remoteEnvironment(virtualMachine) {
  if (!virtualMachine || typeof virtualMachine !== "object") return null;
  const conditions = Array.isArray(virtualMachine.conditions) ? virtualMachine.conditions : [];
  const hibernated = conditions.find((condition) => condition?.type === "Hibernated");
  const ready = conditions.find((condition) => condition?.type === "Ready");
  const hibernationReason = String(hibernated?.reason ?? "");
  let state = "unknown";
  if (hibernationReason && !hibernationReason.startsWith("Not") && /hibernat/i.test(hibernationReason)) state = "hibernated";
  else if (ready && (ready.status === 2 || ready.status === true || String(ready.reason).toLowerCase() === "ready")) state = "running";
  else if (/offline|stopped|error|failed/i.test(String(virtualMachine.status))) state = "offline";
  else if (/online|running|ready/i.test(String(virtualMachine.status))) state = "running";

  const latestTransition = conditions
    .map((condition) => cleanTransitionTime(condition?.last_transition_time))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    id: virtualMachine.id ? String(virtualMachine.id) : null,
    environmentId: virtualMachine.environment_id ? String(virtualMachine.environment_id) : null,
    name: virtualMachine.name ? String(virtualMachine.name) : null,
    status: virtualMachine.status ? String(virtualMachine.status) : null,
    state,
    stateChangedAt: latestTransition,
    os: virtualMachine.os ? String(virtualMachine.os) : null,
    cores: finiteNumber(virtualMachine.cores, null),
    memoryBytes: finiteNumber(virtualMachine.memory, null),
    lifeTimeSeconds: finiteNumber(virtualMachine.life_time_seconds, null),
    createdAt: cleanRemoteTime(virtualMachine.created_at),
    readyMessage: ready?.message ? String(ready.message).slice(0, 160) : null,
  };
}

export function normalizeRemoteTask(task, category = null) {
  if (!task || typeof task !== "object" || !task.id) return null;
  const stats = task.stats && typeof task.stats === "object" ? task.stats : {};
  return {
    id: String(task.id),
    name: remoteTaskName(task),
    title: typeof task.title === "string" && task.title.trim() ? task.title.trim() : null,
    summary: typeof task.summary === "string" && task.summary.trim() ? task.summary.trim() : null,
    status: task.status ? String(task.status) : "unknown",
    category,
    type: task.type ? String(task.type) : null,
    subType: task.sub_type ? String(task.sub_type) : null,
    model: remoteModel(task.model),
    imageName: task.image?.name ? String(task.image.name) : null,
    createdAt: cleanRemoteTime(task.created_at),
    lastActiveAt: cleanRemoteTime(task.last_active_at),
    completedAt: cleanRemoteTime(task.completed_at),
    stats: {
      inputTokens: finiteNumber(stats.input_tokens),
      outputTokens: finiteNumber(stats.output_tokens),
      totalTokens: finiteNumber(stats.total_tokens),
      llmRequests: finiteNumber(stats.llm_requests),
    },
    environment: remoteEnvironment(task.virtualmachine),
  };
}

async function listRemoteTaskGroup(config, { statuses, category, quickStart = false }) {
  const tasks = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await requestJson(config, "/api/v1/users/tasks", {
      page,
      size: 50,
      status: statuses.join(","),
      ...(quickStart ? { quick_start: true } : {}),
    });
    const data = responseData(body, "Task list request") ?? {};
    for (const task of Array.isArray(data.tasks) ? data.tasks : []) {
      const normalized = normalizeRemoteTask(task, category);
      if (normalized) tasks.push(normalized);
    }
    if (!data.page_info?.has_next_page) break;
  }
  return tasks;
}

async function getRemoteIdlePolicy(config) {
  const body = await requestJson(
    config,
    "/api/v1/teams/task-vm-idle-policy",
    undefined,
    { unavailableStatuses: [401, 403, 404] },
  );
  if (!body) return { available: false };
  const policy = responseData(body, "Idle policy request");
  if (!policy || typeof policy !== "object") return { available: false };
  return {
    available: true,
    sleepEnabled: Boolean(policy.sleep_enabled),
    sleepSeconds: finiteNumber(policy.effective_sleep_seconds, null),
    sleepInherited: Boolean(policy.sleep_inherited),
    recycleEnabled: Boolean(policy.recycle_enabled),
    recycleSeconds: finiteNumber(policy.effective_recycle_seconds, null),
    recycleInherited: Boolean(policy.recycle_inherited),
  };
}

export async function getRemoteAccountSnapshot(config) {
  const [statusBody, subscriptionBody, walletBody, activeTasks, historyTasks, idlePolicy] = await Promise.all([
    requestJson(config, "/api/v1/users/status"),
    requestJson(config, "/api/v1/users/subscription"),
    requestJson(config, "/api/v1/users/wallet"),
    listRemoteTaskGroup(config, { statuses: ["pending", "processing"], category: "active", quickStart: true }),
    listRemoteTaskGroup(config, { statuses: ["error", "finished"], category: "history" }),
    getRemoteIdlePolicy(config),
  ]);
  const status = responseData(statusBody, "Account request") ?? {};
  const user = status.user ?? status;
  if (!user?.id) throw new AuthExpiredError();
  const subscription = responseData(subscriptionBody, "Subscription request") ?? {};
  const wallet = responseData(walletBody, "Wallet request") ?? {};
  const taskMap = new Map();
  for (const task of [...activeTasks, ...historyTasks]) taskMap.set(task.id, task);
  return {
    profile: {
      id: String(user.id),
      name: user.name ?? user.nickname ?? null,
      avatarUrl: user.avatar_url ?? null,
      role: user.role ?? null,
      status: user.status ?? null,
      isBlocked: Boolean(user.is_blocked),
      wechatBound: Boolean(user.wechat_mp_bound),
    },
    subscription: {
      plan: subscription.plan ?? null,
      autoRenew: Boolean(subscription.auto_renew),
      enableCreditConsumption: Boolean(subscription.enable_credit_consumption),
    },
    wallet: {
      balance: finiteNumber(wallet.balance, null),
      dailyTokenBalance: finiteNumber(wallet.daily_token_balance, null),
      dailyTokenLimit: finiteNumber(wallet.daily_token_limit, null),
    },
    idlePolicy,
    tasks: [...taskMap.values()].sort((a, b) => String(b.lastActiveAt ?? b.createdAt ?? "").localeCompare(String(a.lastActiveAt ?? a.createdAt ?? ""))),
  };
}

export async function getRemoteTaskDetail(config, taskId) {
  const body = await requestJson(config, `/api/v1/users/tasks/${encodeURIComponent(taskId)}`);
  const task = normalizeRemoteTask(responseData(body, "Task detail request"), "detail");
  if (!task) throw new RemoteError("MonkeyCode returned an invalid task detail response");
  return task;
}

function responseError(body, operation) {
  if (!body || typeof body !== "object") return null;
  if (body.code === undefined || body.code === 0 || body.code === 200) return null;
  return new RemoteError(`${operation} failed: ${body.message ?? body.msg ?? `code ${body.code}`}`);
}

export async function checkSession(config) {
  const body = await requestJson(config, "/api/v1/users/status");
  const error = responseError(body, "Session check");
  if (error) throw error;

  const user = body?.data?.user ?? body?.user ?? body?.data;
  if (!user || typeof user !== "object" || !user.id) {
    throw new AuthExpiredError();
  }
  return user;
}

export async function getRecentUserInputs(config) {
  const body = await requestJson(config, "/api/v1/users/tasks/user-inputs", {
    id: config.taskId,
    limit: config.historyLimit,
  });
  const error = responseError(body, "History request");
  if (error) throw error;

  try {
    return extractHistoryItems(body);
  } catch (cause) {
    throw new RemoteError(`Cannot parse MonkeyCode history: ${cause.message}`);
  }
}

export function sendUserInput(config, options = {}) {
  const streamUrl = makeStreamUrl(config.baseUrl, config.taskId);
  const origin = new URL(config.baseUrl).origin;
  const waitForCompletion = Boolean(options.waitForCompletion);
  const completionTimeoutMs = options.completionTimeoutMs ?? config.timeoutMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let acceptedAt = null;
    const socket = new WebSocket(streamUrl, {
      handshakeTimeout: config.timeoutMs,
      headers: {
        Cookie: cookieHeader(config.session),
        Origin: origin,
        "User-Agent": USER_AGENT,
      },
    });

    const timer = setTimeout(() => {
      if (acceptedAt && waitForCompletion) {
        finish(null, { acceptedAt, completionStatus: "stream-timeout" });
      } else {
        finish(new RemoteError("Timed out waiting for MonkeyCode to acknowledge the message"));
      }
    }, waitForCompletion ? completionTimeoutMs : config.timeoutMs);
    const abort = () => finish(new CancelledError());
    config.signal?.addEventListener("abort", abort, { once: true });
    if (config.signal?.aborted) abort();

    function finish(error, result = {}) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error);
      else resolve(result);
    }

    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 302) {
        finish(new AuthExpiredError());
      } else {
        finish(new RemoteError(`WebSocket handshake returned HTTP ${response.statusCode}`, response.statusCode));
      }
    });

    socket.once("open", () => {
      socket.send(encodeUserInput(config.prompt), (error) => {
        if (error) finish(new RemoteError(`Cannot send the MonkeyCode message: ${error.message}`));
      });
    });

    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (event.type === "user-input") {
        acceptedAt = new Date().toISOString();
        if (!waitForCompletion) finish(null, { acceptedAt });
      } else if (event.type === "task-ended") {
        finish(null, {
          acceptedAt: acceptedAt ?? new Date().toISOString(),
          completionStatus: "completed",
          event,
        });
      } else if (event.type === "task-error" || event.type === "error") {
        const message = event.message ?? event.data ?? "unknown error";
        if (acceptedAt && waitForCompletion) {
          finish(null, {
            acceptedAt,
            completionStatus: "failed",
            completionDetail: `MonkeyCode reported an error: ${message}`,
            event,
          });
        } else {
          finish(new RemoteError(`MonkeyCode rejected the message: ${message}`));
        }
      }
    });

    socket.once("error", (error) => {
      finish(new RemoteError(`WebSocket error: ${error.message}`));
    });

    socket.once("close", (code, reason) => {
      if (!settled) {
        if (acceptedAt && waitForCompletion) {
          finish(null, { acceptedAt, completionStatus: "stream-closed" });
        } else {
          finish(new RemoteError(`WebSocket closed before acknowledgement (${code}: ${reason.toString()})`));
        }
      }
    });
  });
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new RemoteError(`Cannot read local state: ${error.message}`);
  }
}

async function writeState(stateFile, state) {
  const directory = path.dirname(stateFile);
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, stateFile);
  } catch (error) {
    throw new RemoteError(`Cannot persist local state: ${error.message}`);
  }
}

export async function runOnce(config, options = {}) {
  if (config.signal?.aborted) throw new CancelledError();
  const now = options.now ?? new Date();
  const log = options.log ?? (() => {});
  const today = dayKey(now, config.timeZone);
  const hash = promptHash(config.prompt);
  const dedupeKey = options.dedupeKey ?? today;

  await checkSession(config);
  log("session valid");

  if (!options.force) {
    const history = await getRecentUserInputs(config);
    if (isDuplicateHistory(history, config.prompt, now, config.timeZone, { since: options.duplicateSince })) {
      log(`skipped: matching message already exists for ${today}`);
      return { status: "duplicate", source: "remote-history", day: today };
    }

    const state = await readState(config.stateFile);
    if (state?.taskId === config.taskId && (state?.dedupeKey ?? state?.day) === dedupeKey && state?.promptHash === hash) {
      log(`skipped: local state already records the message for ${today}`);
      return { status: "duplicate", source: "local-state", day: today };
    }
  }

  if (config.dryRun) {
    log(`dry run: message would be sent for ${today}`);
    return { status: "dry-run", day: today };
  }

  const streamResult = await sendUserInput(config, {
    waitForCompletion: Boolean(options.waitForCompletion),
    completionTimeoutMs: options.completionTimeoutMs,
  });
  const acceptedAt = streamResult.acceptedAt ?? new Date().toISOString();
  await writeState(config.stateFile, {
    taskId: config.taskId,
    day: today,
    dedupeKey,
    promptHash: hash,
    acceptedAt,
  });
  log(`sent: MonkeyCode acknowledged the message for ${today}`);
  return { status: "sent", day: today, acceptedAt, streamCompletion: streamResult };
}
