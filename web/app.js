/* global lucide */

const state = {
  csrf: "",
  page: "overview",
  overview: null,
  accounts: [],
  tasks: [],
  logs: [],
  backups: [],
  settings: null,
  nodePool: { available: false, workers: [], jobs: [], jobCounts: {}, error: null },
  deploymentView: "overview",
  selectedTaskId: null,
  newTask: false,
  selectedAccountId: null,
  accountDialogReturnToTask: false,
  selectedNotificationId: null,
  bridgeAccountId: null,
  bridgePairCode: null,
  selectedRemoteKey: null,
  remoteTaskDetails: {},
  newTaskSeed: null,
  syncingAccounts: new Set(),
  renewingAccounts: new Set(),
  taskFormDirty: false,
  settingsFormDirty: false,
};

const pageMeta = {
  overview: ["运行概览", "系统状态与下一次计划"],
  tasks: ["任务管理", "配置发送内容、账号与日程"],
  remote: ["远端任务", "账号任务、模型用量与环境状态"],
  accounts: ["账号管理", "集中维护 MonkeyCode 登录凭证"],
  deployments: ["项目部署", "跨 MonkeyCode 环境调度普通项目"],
  history: ["执行记录", "查看每次调度与通知结果"],
  settings: ["系统设置", "全局调度、通知与备份"],
};

const statusLabels = {
  sent: "发送成功",
  accepted: "消息已接收",
  completed: "远端已完成",
  "completion-timeout": "完成确认超时",
  "auto-paused": "连续失败已暂停",
  duplicate: "重复跳过",
  "dry-run": "模拟运行",
  "auth-expired": "登录失效",
  "session-warning": "凭证即将到期",
  failed: "执行失败",
  valid: "有效",
  invalid: "无效",
  missing: "未配置",
  expired: "已过期",
  expiring: "即将到期",
  unknown: "待验证",
  connected: "已连接",
  connecting: "正在连接",
  reconnecting: "正在重连",
  starting: "准备连接",
  paused: "已暂停",
  off: "已关闭",
  "account-mismatch": "账号不匹配",
  running: "运行中",
  queued: "排队中",
  cancelled: "已取消",
  "quota-blocked": "额度保护已阻止",
  processing: "运行中",
  pending: "等待中",
  finished: "已完成",
  error: "异常",
  synced: "已同步",
  stale: "待同步",
  never: "未同步",
  "quota-low": "额度不足",
  "remote-task-error": "远端任务异常",
  "environment-hibernated": "环境已休眠",
  "remote-task-missing": "远端任务未找到",
  "sync-failed": "同步失败",
};

const notificationLabels = {
  generic: "通用 Webhook",
  wecom: "企业微信",
  dingtalk: "钉钉",
  pxyb: "PXYB 微信通知",
  telegram: "Telegram",
  bark: "Bark",
  email: "电子邮件",
};

const notificationEventLabels = {
  sent: "发送成功",
  completed: "远端完成",
  "completion-timeout": "完成确认超时",
  "auto-paused": "连续失败暂停",
  failed: "发送失败",
  "auth-expired": "登录失效",
  "session-warning": "凭证即将到期",
  "auto-login-failed": "自动续期失败",
  "auto-login-recovered": "自动续期已恢复",
  duplicate: "重复跳过",
  "quota-low": "额度不足",
  "remote-task-error": "远端异常",
  "environment-hibernated": "环境休眠",
  "remote-task-missing": "任务丢失",
  "sync-failed": "同步失败",
};

const deploymentStatusLabels = {
  queued: "排队",
  leased: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const deploymentTypeLabels = { deploy: "部署", start: "启动", stop: "停止", restart: "重启" };
const deploymentTypeIcons = { deploy: "rocket", start: "play", stop: "square", restart: "rotate-cw" };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function icons() {
  lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.innerHTML = `<i data-lucide="${type === "error" ? "circle-alert" : "circle-check"}"></i><p>${escapeHtml(message)}</p>`;
  $("#toast-region").append(item);
  icons();
  setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrf && options.method && !["GET", "HEAD"].includes(options.method)) headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401 && path !== "/api/auth/login") {
    showLogin();
    throw new Error("管理会话已失效，请重新登录");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败 (${response.status})`);
  return payload;
}

function showLogin() {
  $("#app").hidden = true;
  $("#login-view").hidden = false;
  $("#login-password").value = "";
  setTimeout(() => $("#login-password").focus(), 0);
  icons();
}

function showApp() {
  $("#login-view").hidden = true;
  $("#app").hidden = false;
  icons();
}

function formatDate(value, withSeconds = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return Math.round(number).toLocaleString("zh-CN");
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function relativeTime(value) {
  if (!value) return "—";
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "—";
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function allRemoteTasks() {
  return state.accounts.flatMap((account) => (account.remoteSnapshot?.tasks ?? []).map((task) => ({
    ...task,
    accountId: account.id,
    accountName: account.name,
    baseUrl: account.baseUrl,
  })));
}

function remoteKey(accountId, taskId) {
  return `${accountId}:${taskId}`;
}

function nextRunText(nextRun) {
  if (!nextRun) return "未安排";
  const milliseconds = new Date(nextRun.at).getTime() - Date.now();
  if (milliseconds <= 0) return "即将执行";
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  return `${days} 天后`;
}

function latestTaskLog(taskId) {
  return state.logs.find((entry) => entry.taskId === taskId && entry.type === "task-run");
}

function statusBadge(status, fallback = "未知") {
  return `<span class="badge ${escapeHtml(status || "unknown")}">${escapeHtml(statusLabels[status] || fallback)}</span>`;
}

function environmentKeeperBadge(task) {
  const status = task.environmentKeepAlive?.status ?? (task.keepAwake ? "starting" : "off");
  return statusBadge(status, status);
}

function environmentKeeperHtml(task, isNew) {
  const keepAlive = task.environmentKeepAlive ?? { status: task.keepAwake ? "starting" : "off" };
  const status = isNew && task.keepAwake ? "starting" : keepAlive.status;
  let connectionDetail = "控制通道未启用";
  if (isNew && task.keepAwake) connectionDetail = "保存任务后建立控制通道";
  else if (status === "connected") connectionDetail = keepAlive.lastPingAt ? `最近心跳 ${relativeTime(keepAlive.lastPingAt)}` : "已建立无消息控制通道";
  else if (status === "reconnecting") connectionDetail = keepAlive.nextRetryAt ? `计划 ${relativeTime(keepAlive.nextRetryAt)}重试` : "连接中断，正在自动重试";
  else if (status === "auth-expired") connectionDetail = "Cookie 无效，请更新账号凭证";
  else if (status === "paused") connectionDetail = "全局自动化已暂停";
  else if (["starting", "connecting"].includes(status)) connectionDetail = "正在建立无消息控制通道";
  const renewalDetail = !task.enabled
    ? "回收续期未启用（自动调度关闭）"
    : task.dryRun
      ? "回收续期未启用（计划仅模拟）"
      : "回收期限由成功的计划真实发送刷新";
  return `<div class="keeper-status"><span class="keeper-icon"><i data-lucide="power"></i></span><div><strong>环境控制通道</strong><small>${escapeHtml(connectionDetail)} · ${escapeHtml(renewalDetail)}</small></div>${statusBadge(status, status)}</div>`;
}

async function loadData() {
  const page = state.page;
  const needsSettings = !state.settings || ["accounts", "settings"].includes(page);
  const logLimit = page === "history" ? 500 : page === "tasks" ? 100 : 0;
  const [overview, settings, logs, backups, nodePool] = await Promise.all([
    api(`/api/overview?activity=${page === "overview" ? "1" : "0"}`),
    needsSettings ? api("/api/settings") : Promise.resolve(state.settings),
    logLimit ? api(`/api/logs?limit=${logLimit}`) : Promise.resolve(null),
    page === "settings" ? api("/api/backups") : Promise.resolve(null),
    page === "deployments" ? api("/api/node-pool/overview").catch((error) => ({
      available: false,
      workers: [],
      jobs: [],
      jobCounts: {},
      error: error.message,
    })) : Promise.resolve(null),
  ]);
  state.overview = overview;
  state.accounts = overview.accounts;
  state.tasks = overview.tasks;
  state.settings = settings;
  if (logs) state.logs = logs.logs;
  if (backups) state.backups = backups.backups;
  if (nodePool) state.nodePool = nodePool;
  if (state.selectedTaskId && !state.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
    state.taskFormDirty = false;
  }
  $("#nav-task-count").textContent = state.tasks.length;
  $("#nav-account-count").textContent = state.accounts.length;
  $("#nav-remote-count").textContent = allRemoteTasks().length;
  $("#nav-deployment-count").textContent = (state.nodePool.jobCounts?.queued ?? 0) + (state.nodePool.jobCounts?.leased ?? 0);
  $("#last-refresh").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  renderCurrentPage();
}

function renderCurrentPage() {
  if (state.page === "overview") renderOverview();
  if (state.page === "tasks") {
    renderTaskList();
    if (!state.taskFormDirty || !$("#task-form")) renderTaskEditor();
  }
  if (state.page === "remote") renderRemoteTasks();
  if (state.page === "accounts") renderAccounts();
  if (state.page === "deployments") renderDeployments();
  if (state.page === "history") {
    renderHistoryFilters();
    renderHistory();
  }
  if (state.page === "settings" && !state.settingsFormDirty) renderSettings();
  if ($("#browser-bridge-dialog")?.open) renderBrowserBridgeDialog();
  icons();
}

function renderOverview() {
  if (!state.overview) return;
  const enabledTasks = state.tasks.filter((task) => task.enabled);
  const failures = state.logs.filter((log) => ["failed", "auth-expired", "completion-timeout", "auto-paused"].includes(log.status)).length;
  const remoteAlerts = state.accounts.flatMap((account) => {
    const alerts = (account.remoteSnapshot?.alerts ?? []).map((alert) => ({ ...alert, accountId: account.id, accountName: account.name }));
    if (account.remoteSyncStatus === "error") alerts.unshift({
      id: `sync-${account.id}`,
      severity: "critical",
      title: `${account.name} 同步失败`,
      detail: account.remoteSyncError || "无法读取 MonkeyCode 账号信息",
      accountId: account.id,
      accountName: account.name,
    });
    return alerts;
  });
  const nextRuns = enabledTasks.map((task) => task.nextRun).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
  const runStats = state.overview.runStats ?? {};
  $("#stats-grid").innerHTML = [
    ["calendar-check", "已启用任务", `${enabledTasks.length}/${state.tasks.length}`, state.overview.enabled ? "全局调度已开启" : "全局调度已暂停"],
    ["clock-3", "最近计划", nextRuns[0] ? nextRunText(nextRuns[0]) : "暂无", nextRuns[0] ? `${nextRuns[0].localDate} ${nextRuns[0].localTime}` : "请配置并启用任务"],
    ["chart-no-axes-combined", "7 天成功率", runStats.successRate === null || runStats.successRate === undefined ? "暂无" : `${runStats.successRate}%`, `${runStats.successful ?? 0} 次成功 / ${runStats.failed ?? 0} 次失败`],
    ["triangle-alert", "待处理异常", String(remoteAlerts.length + failures), remoteAlerts.length ? "存在账号或远端任务异常" : failures ? "请检查执行记录" : "暂无需要处理的异常"],
  ].map(([icon, label, value, note]) => `<article class="stat-card"><div class="stat-card-top"><span>${label}</span><span class="stat-icon"><i data-lucide="${icon}"></i></span></div><div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-note">${escapeHtml(note)}</div></div></article>`).join("");

  $("#overview-alerts").innerHTML = remoteAlerts.length
    ? remoteAlerts.slice(0, 8).map((alert) => `<button class="alert-row ${escapeHtml(alert.severity || "warning")}" type="button" data-alert-account="${alert.accountId}"><span class="alert-icon"><i data-lucide="${alert.severity === "critical" ? "circle-alert" : alert.severity === "info" ? "circle-dot" : "triangle-alert"}"></i></span><span><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.accountName)} · ${escapeHtml(alert.detail)}</small></span><i data-lucide="chevron-right"></i></button>`).join("")
    : "";

  if (state.tasks.length === 0) {
    $("#overview-tasks").innerHTML = emptyState("calendar-plus", "还没有任务，请先新建一个定时任务。");
  } else {
    $("#overview-tasks").innerHTML = `<table><thead><tr><th>任务</th><th>状态</th><th>账号 / 凭证</th><th>下一次执行</th><th>最近结果</th><th></th></tr></thead><tbody>${state.tasks.map((task) => {
      const log = latestTaskLog(task.id);
      const [sessionClass, sessionText] = credentialBadgeSpec(task.accountCredentialStatus);
      return `<tr><td><div class="task-name"><span class="task-name-icon"><i data-lucide="message-square-text"></i></span><div><strong>${escapeHtml(task.name)}</strong><span>${escapeHtml(task.monkeyTaskId)}</span></div></div></td><td><div class="badge-stack">${task.running ? statusBadge("running") : task.queued ? statusBadge("queued", `排队 ${task.queuePosition}`) : task.enabled ? statusBadge("enabled", "已启用") : statusBadge("paused", "已暂停")}${environmentKeeperBadge(task)}</div></td><td><strong>${escapeHtml(task.accountName || "未选择账号")}</strong><div class="credential-line"><span class="badge ${sessionClass}">${sessionText}</span></div></td><td><strong>${escapeHtml(nextRunText(task.nextRun))}</strong><div class="muted">${task.nextRun ? escapeHtml(`${task.nextRun.localDate} ${task.nextRun.localTime}`) : "—"}</div></td><td>${log ? statusBadge(log.status) : '<span class="muted">暂无记录</span>'}</td><td><button class="icon-button" type="button" data-open-task="${task.id}" title="编辑任务" aria-label="编辑任务"><i data-lucide="chevron-right"></i></button></td></tr>`;
    }).join("")}</tbody></table>`;
  }

  $("#overview-logs").innerHTML = state.overview.logs.length
    ? state.overview.logs.map(activityHtml).join("")
    : emptyState("history", "暂无运行记录。");
}

function activityHtml(log) {
  const icon = ["sent", "completed", "synced"].includes(log.status) ? "circle-check" : ["failed", "auth-expired", "session-warning", "completion-timeout", "auto-paused"].includes(log.status) ? "circle-alert" : log.type === "notification" ? "bell" : "circle-dot";
  return `<div class="activity-item"><span class="activity-icon"><i data-lucide="${icon}"></i></span><div class="activity-copy"><strong>${escapeHtml(log.taskName || log.accountName || log.notificationName || "系统事件")} · ${escapeHtml(statusLabels[log.status] || log.status)}</strong><p>${escapeHtml(log.detail || "")}</p></div><time class="activity-time">${formatDate(log.at)}</time></div>`;
}

function emptyState(icon, message) {
  return `<div class="empty-state"><div><i data-lucide="${icon}"></i><p>${escapeHtml(message)}</p></div></div>`;
}

function accountBadge(account) {
  const [className, label] = credentialBadgeSpec(account.credentialStatus);
  return `<span class="badge ${className}">${label}</span>`;
}

function credentialBadgeSpec(status) {
  if (status === "valid") return ["valid", "验证有效"];
  if (status === "expiring") return ["expiring", "即将到期"];
  if (status === "expired") return ["expired", "Cookie 已过期"];
  if (status === "invalid") return ["invalid", "验证失败"];
  if (status === "missing") return ["invalid", "缺少 Cookie"];
  return ["unknown", "待验证"];
}

function credentialDetail(account) {
  const session = account.sessionExpiresAt
    ? `到期 ${formatDate(account.sessionExpiresAt, true)}`
    : account.lastValidatedAt
      ? `验证于 ${formatDate(account.lastValidatedAt)}`
      : "尚未验证";
  if (!account.loginConfigured) return session;
  if (!account.autoLoginEnabled) return `${session} · 自动续期已关闭`;
  if (account.lastAutoLoginStatus === "failed") return `${session} · 自动续期失败`;
  return `${session} · 自动续期已开启`;
}

function bridgeBadge(bridge) {
  const status = bridge.lastStatus || "connected";
  const className = status === "valid" ? "valid" : status === "account-mismatch" || status === "invalid" ? "invalid" : "unknown";
  return `<span class="badge ${className}">${escapeHtml(statusLabels[status] || status)}</span>`;
}

function accountHost(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return baseUrl || "—"; }
}

function renderAccounts() {
  const container = $("#account-list");
  if (!container) return;
  if (state.accounts.length === 0) {
    container.innerHTML = emptyState("user-plus", "还没有账号，请先添加 MonkeyCode 登录凭证。");
    return;
  }
  container.innerHTML = `<table><thead><tr><th>账号</th><th>登录状态</th><th>套餐 / 每日额度</th><th>远端任务</th><th>远端同步</th><th>关联调度</th><th></th></tr></thead><tbody>${state.accounts.map((account) => {
    const snapshot = account.remoteSnapshot;
    const profile = snapshot?.profile;
    const wallet = snapshot?.wallet;
    const limit = Number(wallet?.dailyTokenLimit);
    const remaining = Number(wallet?.dailyTokenBalance);
    const quotaPercent = Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) ? Math.max(0, Math.min(100, remaining / limit * 100)) : null;
    const syncClass = account.remoteSyncStatus === "synced" ? "valid" : account.remoteSyncStatus === "error" ? "invalid" : "unknown";
    const syncLabel = account.remoteSyncStatus === "synced" ? "已同步" : account.remoteSyncStatus === "error" ? "同步失败" : "待同步";
    const initial = Array.from(profile?.name || account.userName || account.name || "M")[0];
    return `<tr><td><div class="account-name"><span class="account-avatar account-initial">${escapeHtml(initial)}</span><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(profile?.name || account.userName || accountHost(account.baseUrl))}${profile?.role ? ` · ${escapeHtml(profile.role)}` : ""}</span></div></div></td><td>${accountBadge(account)}<div class="muted validation-time" title="${escapeHtml(account.lastAutoLoginError || "")}">${escapeHtml(credentialDetail(account))}</div></td><td><strong>${escapeHtml(snapshot?.subscription?.plan ? String(snapshot.subscription.plan).toUpperCase() : "—")}</strong><div class="quota-line"><span>${formatNumber(remaining)} / ${formatNumber(limit)}</span>${quotaPercent === null ? "" : `<span>${quotaPercent.toFixed(0)}%</span>`}</div><div class="quota-track"><span style="width:${quotaPercent ?? 0}%"></span></div></td><td><strong>${snapshot?.tasks?.length ?? 0}</strong><div class="muted validation-time">${snapshot ? `${snapshot.tasks.filter((task) => ["processing", "pending"].includes(task.status)).length} 个活跃` : "尚未读取"}</div></td><td><span class="badge ${syncClass}">${syncLabel}</span><div class="muted validation-time" title="${escapeHtml(account.remoteSyncError || "")}">${account.remoteSyncedAt ? relativeTime(account.remoteSyncedAt) : account.remoteSyncError ? escapeHtml(account.remoteSyncError) : "尚未同步"}</div></td><td><strong>${account.taskCount}</strong> 个任务<div class="muted validation-time">${account.bridges?.length ?? 0} 个浏览器</div></td><td><div class="row-actions"><button class="icon-button ${state.syncingAccounts.has(account.id) ? "is-spinning" : ""}" type="button" data-account-sync="${account.id}" ${account.sessionConfigured && !state.syncingAccounts.has(account.id) ? "" : "disabled"} title="同步账号与远端任务" aria-label="同步账号与远端任务"><i data-lucide="cloud-download"></i></button><button class="icon-button ${state.renewingAccounts.has(account.id) ? "is-spinning" : ""}" type="button" data-account-renew="${account.id}" ${account.loginConfigured && !state.renewingAccounts.has(account.id) ? "" : "disabled"} title="立即自动登录续期" aria-label="立即自动登录续期"><i data-lucide="refresh-cw"></i></button>${state.settings?.browserBridgeEnabled ? `<button class="icon-button" type="button" data-account-bridge="${account.id}" title="浏览器同步" aria-label="浏览器同步"><i data-lucide="plug-zap"></i></button>` : ""}<button class="icon-button" type="button" data-account-check="${account.id}" ${account.sessionConfigured ? "" : "disabled"} title="验证 Cookie" aria-label="验证 Cookie"><i data-lucide="shield-check"></i></button><button class="icon-button" type="button" data-account-edit="${account.id}" title="编辑账号" aria-label="编辑账号"><i data-lucide="pencil"></i></button><button class="icon-button" type="button" data-account-delete="${account.id}" title="删除账号" aria-label="删除账号"><i data-lucide="trash-2"></i></button></div></td></tr>`;
  }).join("")}</tbody></table>`;
}

function formatPolicySeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "未设置";
  if (value % 86_400 === 0) return `${value / 86_400} 天`;
  if (value % 3_600 === 0) return `${value / 3_600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
}

function filteredRemoteTasks() {
  const accountId = $("#remote-account-filter")?.value ?? "";
  const status = $("#remote-status-filter")?.value ?? "";
  const search = ($("#remote-search")?.value ?? "").trim().toLowerCase();
  return allRemoteTasks().filter((task) => (
    (!accountId || task.accountId === accountId)
    && (!status || task.status === status)
    && (!search || `${task.name} ${task.id} ${task.model?.name ?? ""}`.toLowerCase().includes(search))
  ));
}

function selectedRemoteTask() {
  if (!state.selectedRemoteKey) return null;
  const [accountId, taskId] = state.selectedRemoteKey.split(":");
  const cached = allRemoteTasks().find((task) => task.accountId === accountId && task.id === taskId);
  if (!cached) return null;
  return { ...cached, ...(state.remoteTaskDetails[state.selectedRemoteKey] ?? {}) };
}

function renderRemoteTaskDetail() {
  const container = $("#remote-task-detail");
  const task = selectedRemoteTask();
  if (!task) {
    container.innerHTML = '<div class="remote-detail-empty"><i data-lucide="panel-right-open"></i><p>选择一个远端任务查看详情</p></div>';
    return;
  }
  const account = state.accounts.find((item) => item.id === task.accountId);
  const policy = account?.remoteSnapshot?.idlePolicy;
  const environment = task.environment;
  const officialUrl = `${String(task.baseUrl || account?.baseUrl || "").replace(/\/$/, "")}/console/task/${task.id}`;
  const policyHtml = policy?.available
    ? `<div><dt>休眠策略</dt><dd>${policy.sleepEnabled ? `空闲 ${formatPolicySeconds(policy.sleepSeconds)}` : "已关闭"}</dd></div><div><dt>回收策略</dt><dd>${policy.recycleEnabled ? `空闲 ${formatPolicySeconds(policy.recycleSeconds)}` : "已关闭"}</dd></div>`
    : '<div><dt>休眠策略</dt><dd>由 MonkeyCode 平台控制</dd></div><div><dt>精确截止时间</dt><dd>平台未提供</dd></div>';
  container.innerHTML = `<div class="remote-detail-header"><div><p class="eyebrow">REMOTE TASK</p><h2>${escapeHtml(task.name)}</h2><span class="mono">${escapeHtml(task.id)}</span></div><div class="remote-detail-actions"><button class="icon-button" type="button" data-remote-refresh-detail title="刷新详情" aria-label="刷新详情"><i data-lucide="refresh-cw"></i></button><a class="icon-button" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer" title="打开 MonkeyCode" aria-label="打开 MonkeyCode"><i data-lucide="external-link"></i></a></div></div>
    <div class="remote-detail-badges">${statusBadge(task.status, task.status)}${environmentBadge(environment)}<span class="badge unknown">${escapeHtml(account?.name || "未知账号")}</span></div>
    <dl class="remote-detail-grid"><div><dt>模型</dt><dd>${escapeHtml(task.model?.name || "—")}</dd></div><div><dt>任务类型</dt><dd>${escapeHtml(task.type || "—")}</dd></div><div><dt>创建时间</dt><dd>${formatDate(task.createdAt, true)}</dd></div><div><dt>最后活动</dt><dd>${formatDate(task.lastActiveAt, true)}</dd></div></dl>
    <section class="remote-detail-section"><div class="remote-detail-title"><h3>模型用量</h3><span>${task.stats?.llmRequests ?? 0} 次请求</span></div><dl class="remote-metrics"><div><dt>输入</dt><dd>${formatNumber(task.stats?.inputTokens)}</dd></div><div><dt>输出</dt><dd>${formatNumber(task.stats?.outputTokens)}</dd></div><div><dt>总计</dt><dd>${formatNumber(task.stats?.totalTokens)}</dd></div><div><dt>上下文</dt><dd>${formatNumber(task.model?.contextLimit)}</dd></div></dl></section>
    <section class="remote-detail-section"><div class="remote-detail-title"><h3>开发环境</h3><span>${environment?.stateChangedAt ? `状态更新 ${relativeTime(environment.stateChangedAt)}` : "当前任务未返回环境"}</span></div><dl class="remote-detail-grid">${environment ? `<div><dt>系统</dt><dd>${escapeHtml(environment.os || "—")}</dd></div><div><dt>规格</dt><dd>${environment.cores ?? "—"} 核 · ${formatBytes(environment.memoryBytes)}</dd></div><div><dt>环境状态</dt><dd>${escapeHtml(statusLabels[environment.state] || ({ hibernated: "已休眠", offline: "离线" })[environment.state] || "未知")}</dd></div><div><dt>环境创建</dt><dd>${formatDate(environment.createdAt, true)}</dd></div>` : '<div><dt>环境</dt><dd>暂无环境信息</dd></div>'}${policyHtml}</dl></section>
    <div class="remote-detail-footer"><button class="button primary" type="button" data-use-remote-task><i data-lucide="calendar-plus"></i><span>创建定时任务</span></button></div>`;
}

function renderRemoteTasks() {
  const accountFilter = $("#remote-account-filter");
  if (!accountFilter) return;
  const currentAccount = accountFilter.value;
  accountFilter.innerHTML = `<option value="">全部账号</option>${state.accounts.map((account) => `<option value="${account.id}">${escapeHtml(account.name)}</option>`).join("")}`;
  accountFilter.value = state.accounts.some((account) => account.id === currentAccount) ? currentAccount : "";
  const tasks = filteredRemoteTasks();
  const allTasks = allRemoteTasks();
  if (state.selectedRemoteKey && !allTasks.some((task) => remoteKey(task.accountId, task.id) === state.selectedRemoteKey)) state.selectedRemoteKey = null;
  if (!state.selectedRemoteKey && tasks.length) state.selectedRemoteKey = remoteKey(tasks[0].accountId, tasks[0].id);
  const active = allTasks.filter((task) => ["processing", "pending"].includes(task.status)).length;
  const errors = allTasks.filter((task) => task.status === "error").length;
  const synced = state.accounts.filter((account) => account.remoteSyncStatus === "synced").length;
  $("#remote-summary").innerHTML = `<div><span>远端任务</span><strong>${allTasks.length}</strong></div><div><span>活跃</span><strong>${active}</strong></div><div><span>异常</span><strong class="${errors ? "text-danger" : ""}">${errors}</strong></div><div><span>已同步账号</span><strong>${synced}/${state.accounts.length}</strong></div>`;
  $("#remote-task-list").innerHTML = tasks.length
    ? `<div class="remote-table-wrap"><table><thead><tr><th>远端任务</th><th>账号</th><th>状态</th><th>模型</th><th>Token</th><th>环境</th><th>最后活动</th></tr></thead><tbody>${tasks.map((task) => `<tr class="remote-task-row ${state.selectedRemoteKey === remoteKey(task.accountId, task.id) ? "selected" : ""}" data-remote-task="${escapeHtml(remoteKey(task.accountId, task.id))}" tabindex="0"><td><strong>${escapeHtml(task.name)}</strong><span class="mono">${escapeHtml(task.id)}</span></td><td>${escapeHtml(task.accountName)}</td><td>${statusBadge(task.status, task.status)}</td><td>${escapeHtml(task.model?.name || "—")}</td><td>${formatNumber(task.stats?.totalTokens)}</td><td>${environmentBadge(task.environment)}</td><td title="${escapeHtml(formatDate(task.lastActiveAt, true))}">${relativeTime(task.lastActiveAt)}</td></tr>`).join("")}</tbody></table></div>`
    : emptyState("cloud-off", state.accounts.some((account) => account.sessionConfigured) ? "没有符合筛选条件的远端任务。" : "请先配置账号 Cookie，再同步远端任务。");
  renderRemoteTaskDetail();
}

async function syncRemoteAccount(accountId, { preserveTaskForm = false } = {}) {
  if (!accountId || state.syncingAccounts.has(accountId)) return null;
  state.syncingAccounts.add(accountId);
  renderAccounts();
  icons();
  try {
    const response = await api(`/api/accounts/${accountId}/sync-remote`, { method: "POST" });
    const index = state.accounts.findIndex((account) => account.id === accountId);
    if (index >= 0) state.accounts[index] = response.account;
    $("#nav-remote-count").textContent = allRemoteTasks().length;
    renderAccounts();
    renderRemoteTasks();
    renderOverview();
    if (preserveTaskForm && $("#task-form")?.elements.accountId.value === accountId) {
      const selectedId = $("#task-form").elements.remoteTaskId?.value || $("#task-form").elements.manualTaskId?.value || "";
      $("#remote-task-picker").outerHTML = remoteTaskPickerHtml(accountId, selectedId);
    }
    icons();
    toast(`已同步 ${response.account.remoteSnapshot?.tasks?.length ?? 0} 个远端任务`);
    return response.account;
  } catch (error) {
    toast(error.message, "error");
    await loadData().catch(() => {});
    return null;
  } finally {
    state.syncingAccounts.delete(accountId);
    renderAccounts();
    icons();
  }
}

async function renewAccountSession(accountId) {
  if (!accountId || state.renewingAccounts.has(accountId)) return null;
  state.renewingAccounts.add(accountId);
  renderAccounts();
  icons();
  try {
    const response = await api(`/api/accounts/${accountId}/renew-session`, { method: "POST" });
    await loadData();
    toast("自动登录成功，Cookie 已续期");
    return response.account;
  } catch (error) {
    toast(error.message, "error");
    await loadData().catch(() => {});
    return null;
  } finally {
    state.renewingAccounts.delete(accountId);
    renderAccounts();
    icons();
  }
}

async function refreshRemoteDetail() {
  const task = selectedRemoteTask();
  if (!task) return;
  try {
    const response = await api(`/api/accounts/${task.accountId}/remote-tasks/${task.id}`);
    state.remoteTaskDetails[state.selectedRemoteKey] = response.task;
    renderRemoteTaskDetail();
    icons();
    toast("远端任务详情已刷新");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function generateBridgePairCode() {
  if (!state.bridgeAccountId) return;
  try {
    state.bridgePairCode = await api("/api/browser-bridge/pair-code", {
      method: "POST",
      body: { accountId: state.bridgeAccountId },
    });
    renderBrowserBridgeDialog();
    icons();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderBrowserBridgeDialog() {
  const account = state.accounts.find((item) => item.id === state.bridgeAccountId);
  if (!account) return;
  $("#browser-bridge-account").textContent = account.name;
  const pair = state.bridgePairCode;
  $("#browser-pair-code").innerHTML = pair
    ? `<div class="pair-code-row"><code>${escapeHtml(pair.code)}</code><button class="icon-button" type="button" data-copy-pair-code title="复制配对码" aria-label="复制配对码"><i data-lucide="copy"></i></button></div><time>有效至 ${formatDate(pair.expiresAt, true)}</time>`
    : '<span class="muted">正在生成配对码...</span>';
  $("#browser-device-list").innerHTML = account.bridges?.length
    ? account.bridges.map((bridge) => `<div class="browser-device"><span class="browser-device-icon"><i data-lucide="monitor"></i></span><div><strong>${escapeHtml(bridge.deviceName)}</strong><p>${bridge.lastSyncedAt ? `同步于 ${formatDate(bridge.lastSyncedAt, true)}` : `连接于 ${formatDate(bridge.createdAt, true)}`}</p></div><div class="browser-device-actions">${bridgeBadge(bridge)}<button class="icon-button" type="button" data-bridge-revoke="${bridge.id}" title="断开设备" aria-label="断开设备"><i data-lucide="unlink"></i></button></div></div>`).join("")
    : emptyState("monitor-off", "尚未连接浏览器扩展。" );
}

function openBrowserBridgeDialog(accountId) {
  state.bridgeAccountId = accountId;
  state.bridgePairCode = null;
  renderBrowserBridgeDialog();
  $("#browser-bridge-dialog").showModal();
  icons();
  generateBridgePairCode();
}

function openAccountDialog(id = null, options = {}) {
  const account = id ? state.accounts.find((item) => item.id === id) : null;
  const form = $("#account-form");
  form.reset();
  state.selectedAccountId = account?.id ?? null;
  state.accountDialogReturnToTask = Boolean(options.returnToTask);
  $("#account-dialog-title").textContent = account ? "编辑 MonkeyCode 账号" : "添加 MonkeyCode 账号";
  form.elements.name.value = account?.name ?? "";
  form.elements.baseUrl.value = account?.baseUrl ?? "https://monkeycode-ai.com";
  form.elements.session.value = "";
  form.elements.session.placeholder = account?.sessionConfigured ? "留空表示保持现有 Cookie" : "填写 Cookie 的 Value";
  form.elements.loginEmail.value = "";
  form.elements.loginPassword.value = "";
  form.elements.loginEmail.placeholder = account?.loginConfigured ? "留空表示保持已保存的登录账号" : "填写 MonkeyCode 登录账号";
  form.elements.loginPassword.placeholder = account?.loginConfigured ? "留空表示保持已保存的登录密码" : "填写 MonkeyCode 登录密码";
  form.elements.autoLoginEnabled.checked = account?.autoLoginEnabled ?? false;
  $("#account-session-hint").textContent = account?.sessionConfigured
    ? `当前 Cookie 更新于 ${formatDate(account.sessionUpdatedAt)}，留空不会覆盖。`
    : "填写 Cookie 的 Value，保存时会加密。";
  $("#clear-account-session-row").hidden = !account?.sessionConfigured;
  $("#account-login-hint").textContent = account?.loginConfigured
    ? "登录凭据已加密保存；账号和密码必须同时留空或同时重新填写。"
    : "与密码同时填写，保存后由服务器自动登录。";
  $("#clear-account-login-row").hidden = !account?.loginConfigured;
  $("#account-dialog").showModal();
  setTimeout(() => form.elements.name.focus(), 0);
  icons();
}

function collectAccountForm() {
  const data = new FormData($("#account-form"));
  return {
    name: data.get("name"),
    baseUrl: data.get("baseUrl"),
    session: data.get("session"),
    clearSession: data.get("clearSession") === "on",
    loginEmail: data.get("loginEmail"),
    loginPassword: data.get("loginPassword"),
    autoLoginEnabled: data.get("autoLoginEnabled") === "on",
    clearLogin: data.get("clearLogin") === "on",
  };
}

function deploymentNumber(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "0";
}

function deploymentBadge(status, label = deploymentStatusLabels[status] ?? status) {
  const safeStatus = ["queued", "leased", "completed", "failed", "cancelled", "online", "offline"].includes(status) ? status : "offline";
  return `<span class="badge ${safeStatus}">${escapeHtml(label)}</span>`;
}

function deploymentEmptyRow(columns, message) {
  return `<tr class="deployment-empty-row"><td colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function deploymentProjects() {
  return [...new Set((state.nodePool.workers ?? []).flatMap((worker) => worker.projects ?? []))].sort((a, b) => a.localeCompare(b));
}

function deploymentWorkerUsage(worker) {
  const allocations = worker.allocations ?? [];
  return {
    cpu: allocations.reduce((sum, entry) => sum + (Number(entry.cpu) || 0), 0),
    memoryMb: allocations.reduce((sum, entry) => sum + (Number(entry.memoryMb) || 0), 0),
  };
}

function renderDeployments() {
  const pool = state.nodePool;
  const workers = pool.workers ?? [];
  const jobs = pool.jobs ?? [];
  const counts = pool.jobCounts ?? {};
  const online = workers.filter((worker) => worker.online).length;
  const error = $("#deployment-error");
  error.hidden = pool.available !== false;
  error.textContent = pool.error || "节点池控制器暂时不可用";

  $("#deployment-stats").innerHTML = [
    ["server", "在线节点", online, `共 ${workers.length} 个节点`],
    ["folder-git-2", "可用项目", deploymentProjects().length, "Worker 白名单项目"],
    ["activity", "活跃部署任务", (counts.queued ?? 0) + (counts.leased ?? 0), `${counts.queued ?? 0} 排队 · ${counts.leased ?? 0} 执行`],
    ["circle-alert", "失败任务", counts.failed ?? 0, `${counts.completed ?? 0} 个任务已完成`],
  ].map(([icon, label, value, note]) => `<article class="stat-card"><div class="stat-card-top"><span>${label}</span><span class="stat-icon"><i data-lucide="${icon}"></i></span></div><div><div class="stat-value">${deploymentNumber(value)}</div><div class="stat-note">${escapeHtml(note)}</div></div></article>`).join("");

  const overviewWorkers = [...workers].sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id)).slice(0, 6);
  $("#deployment-overview-workers").innerHTML = overviewWorkers.length ? overviewWorkers.map((worker) => {
    const usage = deploymentWorkerUsage(worker);
    return `<tr><td>${deploymentEntity("server", worker.id, (worker.labels ?? []).join(", ") || "无标签")}</td><td>${deploymentBadge(worker.online ? "online" : "offline", worker.online ? "在线" : "离线")}</td><td><strong>${worker.projects?.length ?? 0}</strong><div class="deployment-meta">${worker.allocations?.length ?? 0} 个运行中</div></td><td><div class="deployment-resource"><strong>${deploymentNumber(usage.cpu, 1)} / ${deploymentNumber(worker.capacity?.cpu, 1)} CPU</strong><span>${deploymentNumber(usage.memoryMb)} / ${deploymentNumber(worker.capacity?.memoryMb)} MB</span></div></td></tr>`;
  }).join("") : deploymentEmptyRow(4, pool.available === false ? "节点池控制器不可用" : "尚未接入 Worker");

  const recentJobs = [...jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 7);
  $("#deployment-recent-jobs").innerHTML = recentJobs.length ? recentJobs.map((job) => `
    <button class="deployment-activity" type="button" data-deployment-job-detail="${escapeHtml(job.id)}">
      <span class="deployment-activity-icon"><i data-lucide="${deploymentTypeIcons[job.type] ?? "circle-dot"}"></i></span>
      <span class="deployment-activity-copy"><strong>${escapeHtml(job.project)} · ${escapeHtml(deploymentTypeLabels[job.type] ?? job.type)}</strong><span>${escapeHtml(job.assignedWorkerId || "等待节点")} · ${escapeHtml(job.ref || "-")}</span></span>
      <span class="deployment-activity-side"><time>${formatDate(job.createdAt)}</time>${deploymentBadge(job.status)}</span>
    </button>`).join("") : `<div class="deployment-activity-empty">${pool.available === false ? "节点池控制器不可用" : "暂无部署任务"}</div>`;

  renderDeploymentWorkers();
  renderDeploymentJobs();
  setDeploymentView(state.deploymentView, false);
}

function deploymentEntity(icon, title, detail) {
  return `<div class="deployment-entity"><span class="deployment-entity-icon"><i data-lucide="${icon}"></i></span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function renderDeploymentWorkers() {
  const query = $("#deployment-worker-search").value.trim().toLowerCase();
  const workers = [...(state.nodePool.workers ?? [])].filter((worker) => !query || [
    worker.id,
    ...(worker.labels ?? []),
    ...(worker.projects ?? []),
    ...(worker.allocations ?? []).map((entry) => entry.project),
    ...(worker.projectStates ?? []).flatMap((entry) => [entry.project, entry.publicUrl]),
  ].join(" ").toLowerCase().includes(query)).sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
  $("#deployment-workers").innerHTML = workers.length ? workers.map((worker) => {
    const usage = deploymentWorkerUsage(worker);
    const projects = (worker.projects ?? []).map((project) => `<span class="deployment-tag">${escapeHtml(project)}</span>`).join("") || '<span class="muted">等待新版心跳</span>';
    const states = worker.projectStates?.length ? worker.projectStates : (worker.allocations ?? []).map((entry) => ({ ...entry, desiredStatus: "running" }));
    const runtimes = states.map((entry) => {
      const recovering = entry.restartPolicy !== "never" && entry.desiredStatus === "running" && entry.status !== "running";
      const label = entry.status === "running" ? "运行中" : recovering ? "等待恢复" : entry.status === "not-deployed" ? "未部署" : "已停止";
      return `<span class="deployment-tag"${entry.lastError ? ` title="${escapeHtml(entry.lastError)}"` : ""}>${escapeHtml(entry.project)} · ${label}</span>`;
    }).join("") || '<span class="muted">无</span>';
    const services = states.filter((entry) => entry.publicUrl).map((entry) => entry.status === "running"
      ? `<a class="deployment-service-link" href="${escapeHtml(entry.publicUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>${escapeHtml(entry.project)}</span></a>`
      : `<span class="muted">${escapeHtml(entry.project)} · 未运行</span>`).join("") || '<span class="muted">未配置</span>';
    const agent = worker.agent?.supervised ? "守护运行" : "前台运行";
    return `<tr>
      <td>${deploymentEntity("server", worker.id, (worker.labels ?? []).join(", ") || "无标签")}</td>
      <td>${deploymentBadge(worker.online ? "online" : "offline", worker.online ? "在线" : "离线")}<div class="deployment-meta">${agent} · 负载 ${deploymentNumber(worker.metrics?.load1, 2)}</div></td>
      <td><div class="deployment-resource"><strong>${deploymentNumber(usage.cpu, 1)} / ${deploymentNumber(worker.capacity?.cpu, 1)} CPU</strong><span>${deploymentNumber(usage.memoryMb)} / ${deploymentNumber(worker.capacity?.memoryMb)} MB · 磁盘可用 ${deploymentNumber(worker.metrics?.diskFreeMb)} MB</span></div></td>
      <td><div class="badge-stack">${projects}</div></td><td><div class="badge-stack">${runtimes}</div></td><td><div class="deployment-services">${services}</div></td>
      <td><strong>${relativeTime(worker.lastSeenAt)}</strong><div class="deployment-meta">${formatDate(worker.lastSeenAt, true)}</div></td>
      <td><div class="deployment-row-actions"><button class="icon-button danger-icon" type="button" data-delete-deployment-worker="${escapeHtml(worker.id)}" title="删除节点" aria-label="删除节点 ${escapeHtml(worker.id)}"><i data-lucide="trash-2"></i></button></div></td>
    </tr>`;
  }).join("") : deploymentEmptyRow(8, query ? "没有匹配的节点" : (state.nodePool.available === false ? "节点池控制器不可用" : "尚未接入 Worker"));
}

function renderDeploymentJobs() {
  const query = $("#deployment-job-search").value.trim().toLowerCase();
  const status = $("#deployment-job-status").value;
  const type = $("#deployment-job-type").value;
  const jobs = [...(state.nodePool.jobs ?? [])].filter((job) => {
    if (status && job.status !== status) return false;
    if (type && job.type !== type) return false;
    return !query || [job.id, job.project, job.ref, job.assignedWorkerId, job.preferredWorkerId].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $("#deployment-jobs").innerHTML = jobs.length ? jobs.map((job) => `<tr>
    <td>${deploymentEntity("folder-git-2", job.project, job.id)}</td>
    <td><strong>${escapeHtml(deploymentTypeLabels[job.type] ?? job.type)}</strong><div class="deployment-meta mono">${escapeHtml(job.ref || "-")}</div></td>
    <td>${deploymentBadge(job.status)}<div class="deployment-meta">尝试 ${deploymentNumber(job.attempts)} / ${deploymentNumber(job.maxAttempts)}</div></td>
    <td><strong>${escapeHtml(job.assignedWorkerId || job.preferredWorkerId || "自动选择")}</strong></td>
    <td><strong>${deploymentNumber(job.requirements?.cpu, 1)} CPU</strong><div class="deployment-meta">${deploymentNumber(job.requirements?.memoryMb)} MB · ${escapeHtml((job.requirements?.labels ?? []).join(", ") || "无标签")}</div></td>
    <td><strong>${formatDate(job.createdAt)}</strong><div class="deployment-meta">${job.finishedAt ? `完成 ${formatDate(job.finishedAt)}` : relativeTime(job.createdAt)}</div></td>
    <td><div class="deployment-row-actions"><button class="icon-button" type="button" data-deployment-job-detail="${escapeHtml(job.id)}" title="查看详情" aria-label="查看详情"><i data-lucide="panel-right-open"></i></button>${job.status === "queued" ? `<button class="icon-button" type="button" data-cancel-deployment-job="${escapeHtml(job.id)}" title="取消任务" aria-label="取消任务"><i data-lucide="x-circle"></i></button>` : ""}</div></td>
  </tr>`).join("") : deploymentEmptyRow(7, state.nodePool.available === false ? "节点池控制器不可用" : "没有匹配的部署任务");
}

function setDeploymentView(view, focus = true) {
  if (!["overview", "workers", "jobs"].includes(view)) return;
  state.deploymentView = view;
  $$("[data-deployment-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.deploymentPanel === view));
  $$(".deployment-tab").forEach((tab) => {
    const active = tab.dataset.deploymentView === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  if (focus) $(`.deployment-tab[data-deployment-view="${view}"]`)?.focus();
}

function syncDeploymentJobType() {
  const type = $("#deployment-job-form input[name=type]:checked").value;
  const field = $("#deployment-job-ref-field");
  field.hidden = type !== "deploy";
  field.querySelector("input").required = type === "deploy";
}

function openDeploymentJobDialog() {
  const form = $("#deployment-job-form");
  form.reset();
  $("#deployment-project-options").innerHTML = deploymentProjects().map((project) => `<option value="${escapeHtml(project)}"></option>`).join("");
  $("#deployment-job-worker").innerHTML = '<option value="">自动选择</option>' + [...(state.nodePool.workers ?? [])]
    .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id))
    .map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.id)}${worker.online ? " · 在线" : " · 离线"}</option>`).join("");
  syncDeploymentJobType();
  $("#deployment-job-dialog").showModal();
  setTimeout(() => form.elements.project.focus(), 0);
  icons();
}

function openWorkerTokenDialog() {
  $("#worker-token-form").reset();
  $("#worker-token-result").hidden = true;
  $("#worker-token-value").value = "";
  $("#worker-bundle-url").value = "";
  $("#worker-install-command").value = "";
  $("#worker-token-dialog").showModal();
  setTimeout(() => $("#worker-token-form").elements.nodeId.focus(), 0);
  icons();
}

function shellValue(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function workerInstallCommand({ nodeId, token, bundleUrl, publicUrlTemplate }) {
  const controllerUrl = new URL(bundleUrl);
  controllerUrl.pathname = controllerUrl.pathname.replace(/\/api\/workers\/[^/]+\/bundle\/?$/, "");
  controllerUrl.search = "";
  controllerUrl.hash = "";
  const controller = controllerUrl.toString().replace(/\/$/, "");
  const directory = `.monkeycode-worker-${nodeId}`;
  return `umask 077
WORKER_DIR="$HOME/${directory}"
mkdir -p "$WORKER_DIR"
cd "$WORKER_DIR"
export MK_WORKER_TOKEN=${shellValue(token)}
export MK_PUBLIC_URL_TEMPLATE=${shellValue(publicUrlTemplate ?? "")}
curl -fL -H "Authorization: Bearer \${MK_WORKER_TOKEN}" ${shellValue(bundleUrl)} -o monkeycode-node-pool.tar.gz
tar -xzf monkeycode-node-pool.tar.gz
if [ ! -f worker.config.json ]; then
cat > worker.config.json <<EOF
{
  "version": 1,
  "nodeId": ${JSON.stringify(nodeId)},
  "controllerUrl": ${JSON.stringify(controller)},
  "rootDir": "$WORKER_DIR/data",
  "publicUrlTemplate": ${JSON.stringify(publicUrlTemplate ?? "")},
  "capacity": {
    "cpu": 1,
    "memoryMb": 2048,
    "diskMb": 10240
  },
  "labels": ["node"],
  "pollIntervalSeconds": 5,
  "heartbeatIntervalSeconds": 15,
  "reconcileIntervalSeconds": 15,
  "recovery": {
    "initialDelaySeconds": 5,
    "maxDelaySeconds": 300,
    "healthFailureThreshold": 3
  },
  "projects": {}
}
EOF
fi
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const file = "worker.config.json";
const config = JSON.parse(await readFile(file, "utf8"));
if (process.env.MK_PUBLIC_URL_TEMPLATE) config.publicUrlTemplate = process.env.MK_PUBLIC_URL_TEMPLATE;
config.reconcileIntervalSeconds ??= 15;
config.recovery ??= { initialDelaySeconds: 5, maxDelaySeconds: 300, healthFailureThreshold: 3 };
await writeFile(file, \`\${JSON.stringify(config, null, 2)}\\n\`, { mode: 0o600 });
NODE
export MK_WORKER_CONFIG="$WORKER_DIR/worker.config.json"
npm run service -- install
unset MK_WORKER_TOKEN MK_PUBLIC_URL_TEMPLATE
npm run service -- status`;
}

function publicUrlTemplateFromSample(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("{port}")) {
    const rendered = new URL(raw.replaceAll("{port}", "39080"));
    if (!["http:", "https:"].includes(rendered.protocol) || rendered.username || rendered.password || rendered.search || rendered.hash) throw new Error("端口公网地址格式不正确");
    return raw.replace(/\/+$/, "");
  }
  const url = new URL(raw);
  const match = url.hostname.match(/^\d+-(.+)$/);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !match) {
    throw new Error("请填写端口开头的完整公网地址");
  }
  return `${url.protocol}//{port}-${match[1]}${url.port ? `:${url.port}` : ""}`;
}

function openDeploymentDetail(jobId) {
  const job = (state.nodePool.jobs ?? []).find((entry) => entry.id === jobId);
  if (!job) return;
  $("#deployment-detail-title").textContent = `${deploymentTypeLabels[job.type] ?? job.type} · ${job.project}`;
  const items = [
    ["任务 ID", job.id], ["状态", deploymentStatusLabels[job.status] ?? job.status], ["Git 引用", job.ref || "-"],
    ["执行节点", job.assignedWorkerId || job.preferredWorkerId || "自动选择"], ["创建时间", formatDate(job.createdAt, true)], ["完成时间", formatDate(job.finishedAt, true)],
  ];
  if (job.result?.publicUrl) items.push(["公网地址", job.result.publicUrl]);
  $("#deployment-detail-list").innerHTML = items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#deployment-detail-output").textContent = JSON.stringify(job.error ? { error: job.error } : job.result ?? { message: "暂无执行结果" }, null, 2);
  $("#deployment-detail-dialog").showModal();
  icons();
}

async function copyDeploymentValue(id) {
  const input = document.getElementById(id);
  if (!input?.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(0, 0);
  }
  toast("已复制");
}

function renderTaskList() {
  const container = $("#task-list");
  if (state.tasks.length === 0 && !state.newTask) {
    container.innerHTML = '<p class="muted">暂无任务</p>';
    return;
  }
  container.innerHTML = `${state.newTask ? '<button class="task-list-item active" type="button"><div><strong>新建任务</strong><small>尚未保存</small></div><span class="status-dot warn"></span></button>' : ""}${state.tasks.map((task) => {
    const keeperStatus = task.environmentKeepAlive?.status;
    const environmentText = keeperStatus === "connected" ? "环境已保持" : task.keepAwake ? (statusLabels[keeperStatus] || "环境待连接") : "环境保持关闭";
    const times = task.schedule.times?.length ? task.schedule.times.join("、") : task.schedule.time;
    const runText = task.running ? "正在运行" : task.queued ? `队列第 ${task.queuePosition} 位` : task.enabled ? `${times} · ${scheduleModeText(task.schedule)}` : "调度已暂停";
    return `<button class="task-list-item ${!state.newTask && state.selectedTaskId === task.id ? "active" : ""}" type="button" data-select-task="${task.id}"><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(runText)} · ${escapeHtml(environmentText)}</small></div><span class="status-dot ${task.running || task.queued || ["connecting", "reconnecting", "starting"].includes(keeperStatus) ? "warn" : keeperStatus === "connected" ? "ok" : ""}"></span></button>`;
  }).join("")}`;
}

function defaultTask() {
  const seed = state.newTaskSeed;
  return {
    name: seed?.name ?? "",
    monkeyTaskId: seed?.remoteTaskId ?? "",
    accountId: seed?.accountId ?? state.accounts[0]?.id ?? null,
    enabled: false,
    keepAwake: true,
    dryRun: true,
    dedupe: true,
    prompt: "你好",
    promptVersions: [],
    sessionConfigured: false,
    sessionUpdatedAt: null,
    schedule: { mode: "daily", time: "09:00", times: ["09:00"], timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], catchUp: true, includeDates: [], excludeDates: [] },
    retry: { attempts: 3, delaySeconds: 300 },
    completion: { enabled: true, timeoutMinutes: 30, pollSeconds: 15 },
    failurePolicy: { autoPauseAfter: 3 },
  };
}

function selectedTask() {
  if (state.newTask) return defaultTask();
  return state.tasks.find((task) => task.id === state.selectedTaskId) ?? null;
}

function scheduleModeText(schedule) {
  if (schedule.mode === "daily") return "每天";
  if (schedule.mode === "weekdays") return "工作日";
  return `每周 ${schedule.weekdays.join("、")}`;
}

function remoteTaskFor(accountId, taskId) {
  return state.accounts.find((account) => account.id === accountId)?.remoteSnapshot?.tasks?.find((task) => task.id === taskId) ?? null;
}

function remoteTaskOptions(accountId, selectedId) {
  const account = state.accounts.find((item) => item.id === accountId);
  const tasks = account?.remoteSnapshot?.tasks ?? [];
  const active = tasks.filter((task) => ["processing", "pending"].includes(task.status));
  const history = tasks.filter((task) => !["processing", "pending"].includes(task.status));
  const option = (task) => `<option value="${escapeHtml(task.id)}" ${task.id === selectedId ? "selected" : ""}>${escapeHtml(task.name)} · ${escapeHtml(statusLabels[task.status] || task.status)}</option>`;
  const known = tasks.some((task) => task.id === selectedId);
  return `<option value="">${account?.remoteSyncStatus === "synced" ? "选择 MonkeyCode 任务" : "请先同步该账号"}</option>${selectedId && !known ? `<option value="${escapeHtml(selectedId)}" selected>当前任务 ID（同步结果中未找到）</option>` : ""}${active.length ? `<optgroup label="运行中">${active.map(option).join("")}</optgroup>` : ""}${history.length ? `<optgroup label="历史任务">${history.map(option).join("")}</optgroup>` : ""}`;
}

function environmentBadge(environment) {
  if (!environment) return '<span class="badge unknown">无环境信息</span>';
  if (environment.state === "running") return '<span class="badge valid">环境运行中</span>';
  if (environment.state === "hibernated") return '<span class="badge expiring">环境已休眠</span>';
  if (environment.state === "offline") return '<span class="badge invalid">环境离线</span>';
  return '<span class="badge unknown">环境状态未知</span>';
}

function remoteTaskCompactHtml(task) {
  if (!task) return '<div class="remote-selection-empty"><i data-lucide="cloud-off"></i><span>选择远端任务后显示模型、用量和环境状态</span></div>';
  return `<div class="remote-selection-summary"><div><span>状态</span>${statusBadge(task.status, task.status)}</div><div><span>模型</span><strong>${escapeHtml(task.model?.name || "—")}</strong></div><div><span>Token</span><strong>${formatNumber(task.stats?.totalTokens)}</strong></div><div><span>最后活动</span><strong>${relativeTime(task.lastActiveAt)}</strong></div><div><span>环境</span>${environmentBadge(task.environment)}</div></div>`;
}

function remoteTaskPickerHtml(accountId, selectedId) {
  const account = state.accounts.find((item) => item.id === accountId);
  const task = remoteTaskFor(accountId, selectedId);
  return `<div id="remote-task-picker" class="field full"><span>MonkeyCode 远端任务</span><div class="remote-select-line"><select name="remoteTaskId" aria-label="MonkeyCode 远端任务">${remoteTaskOptions(accountId, selectedId)}</select><button class="button secondary" type="button" data-task-sync-remote ${account?.sessionConfigured ? "" : "disabled"}><i data-lucide="refresh-cw"></i><span>同步</span></button></div><details class="manual-task-id" ${selectedId && !task ? "open" : ""}><summary>手动输入任务 ID</summary><input name="manualTaskId" class="mono" value="${escapeHtml(selectedId || "")}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></details><div id="task-remote-summary">${remoteTaskCompactHtml(task)}</div></div>`;
}

function renderTaskEditor() {
  const task = selectedTask();
  const container = $("#task-editor");
  if (!task) {
    container.innerHTML = '<div class="editor-placeholder"><div><i data-lucide="panel-right-open"></i><p>选择一个任务进行编辑</p></div></div>';
    return;
  }
  const isNew = state.newTask;
  const pending = task.running || task.queued;
  const selectedAccount = state.accounts.find((account) => account.id === task.accountId);
  const sessionStatus = credentialBadgeSpec(selectedAccount?.credentialStatus ?? task.accountCredentialStatus);
  const accountOptions = state.accounts.length
    ? state.accounts.map((account) => `<option value="${account.id}" ${task.accountId === account.id ? "selected" : ""}>${escapeHtml(account.name)}${account.sessionConfigured ? "" : "（缺少 Cookie）"}</option>`).join("")
    : '<option value="">请先添加账号</option>';
  container.innerHTML = `<form id="task-form" class="task-form">
    <div class="editor-header"><div><h2>${isNew ? "创建定时任务" : escapeHtml(task.name)}</h2><p>${isNew ? "保存后可测试登录与发送" : escapeHtml(task.monkeyTaskId)}</p></div><div class="editor-actions">
      <button class="button secondary" type="button" data-task-action="check" ${isNew || !task.accountId ? "disabled" : ""} title="验证登录"><i data-lucide="shield-check"></i><span>验证</span></button>
      <button class="button secondary" type="button" data-task-action="dry-run" ${isNew || pending ? "disabled" : ""} title="模拟运行"><i data-lucide="flask-conical"></i><span>模拟</span></button>
      ${pending ? '<button class="button danger" type="button" data-task-action="stop" title="停止本次运行"><i data-lucide="square"></i><span>停止</span></button>' : `<button class="button primary" type="button" data-task-action="send" ${isNew ? "disabled" : ""} title="立即发送"><i data-lucide="send"></i><span>发送</span></button>`}
    </div></div>
    <section class="editor-section"><div class="editor-section-title"><div><h3>基础信息</h3><p>关联一个 MonkeyCode 对话任务</p></div></div>
      <div class="form-grid"><label class="field"><span>本地调度名称</span><input name="name" maxlength="80" value="${escapeHtml(task.name)}" required></label><div class="field"><span>发送账号</span><div class="account-select-line"><select name="accountId" aria-label="发送账号" required>${accountOptions}</select><button class="button secondary" type="button" data-add-account-from-task title="添加账号"><i data-lucide="user-plus"></i><span>添加</span></button></div><small id="task-account-hint" class="field-hint"><span class="badge ${sessionStatus[0]}">${sessionStatus[1]}</span>${selectedAccount ? ` ${escapeHtml(selectedAccount.name)}` : " 任务保存前必须选择账号"}</small></div>${remoteTaskPickerHtml(task.accountId, task.monkeyTaskId)}</div>
      <div class="toggle-grid">${toggleHtml("enabled", task.enabled, "启用自动调度", "到点后自动执行")}${toggleHtml("keepAwake", task.keepAwake, "持续保持环境", "无消息唤醒与防休眠")}${toggleHtml("dryRun", task.dryRun, "计划仅模拟", "计划运行时不真实发送")}${toggleHtml("dedupe", task.dedupe, "防止重复", "检查远端历史与本地状态")}</div>
      ${environmentKeeperHtml(task, isNew)}
    </section>
    <section class="editor-section"><div class="editor-section-title"><div><h3>发送内容</h3><p>变量会在每次运行时根据任务时区替换</p></div><div class="prompt-toolbar">${["date", "time", "weekday", "task_name"].map((key) => `<button class="variable-chip" type="button" data-variable="{{${key}}}">{{${key}}}</button>`).join("")}</div></div>
      <label class="field"><textarea id="prompt-input" class="prompt-area" name="prompt" maxlength="1048576" required>${escapeHtml(task.prompt)}</textarea></label><div class="prompt-meta"><span>支持日期、时间、星期和任务名称变量</span><span id="prompt-count">${Array.from(task.prompt).length} 字</span></div><div id="prompt-preview" class="prompt-preview">${escapeHtml(renderClientPrompt(task.prompt, task.name, task.schedule.timeZone))}</div>
    </section>
    <section class="editor-section"><div class="editor-section-title"><div><h3>运行计划</h3><p>支持节假日例外和 VPS 离线后的补跑</p></div></div>
      <div class="form-grid three"><label class="field"><span>执行规则</span><select name="scheduleMode"><option value="daily" ${task.schedule.mode === "daily" ? "selected" : ""}>每天</option><option value="weekdays" ${task.schedule.mode === "weekdays" ? "selected" : ""}>周一至周五</option><option value="custom" ${task.schedule.mode === "custom" ? "selected" : ""}>自定义星期</option></select></label><label class="field"><span>执行时间</span><input name="scheduleTimes" value="${escapeHtml((task.schedule.times?.length ? task.schedule.times : [task.schedule.time]).join(", "))}" placeholder="09:00, 18:00" required><small class="field-hint">最多 12 个时间，用逗号分隔。</small></label><label class="field"><span>时区</span><select name="timeZone">${timezoneOptions(task.schedule.timeZone)}</select></label></div>
      <div id="weekday-field" class="field ${task.schedule.mode === "custom" ? "" : "muted"}"><span>自定义星期</span><div class="weekday-row">${[1, 2, 3, 4, 5, 6, 7].map((day) => `<label class="weekday-check"><input type="checkbox" name="weekday" value="${day}" ${task.schedule.weekdays.includes(day) ? "checked" : ""}><span>${["一", "二", "三", "四", "五", "六", "日"][day - 1]}</span></label>`).join("")}</div></div>
      <div class="form-grid"><label class="field"><span>额外执行日期</span><textarea name="includeDates" placeholder="2026-10-01, 2026-10-02">${escapeHtml(task.schedule.includeDates.join(", "))}</textarea><small class="field-hint">即使不符合星期规则也执行。</small></label><label class="field"><span>排除日期</span><textarea name="excludeDates" placeholder="2026-10-01, 2026-10-02">${escapeHtml(task.schedule.excludeDates.join(", "))}</textarea><small class="field-hint">适合录入法定节假日。</small></label></div>
      <div class="toggle-grid">${toggleHtml("catchUp", task.schedule.catchUp, "错过后补跑", "VPS 恢复后执行当天任务")}</div>
    </section>
    <section class="editor-section"><div class="editor-section-title"><div><h3>完成追踪与失败保护</h3><p>消息接收后继续确认远端任务是否真正完成</p></div></div><div class="toggle-grid">${toggleHtml("completionEnabled", task.completion?.enabled !== false, "追踪远端完成状态", "完成或异常后再发送最终通知")}</div><div class="form-grid three"><label class="field"><span>完成超时（分钟）</span><input name="completionTimeoutMinutes" type="number" min="1" max="180" value="${task.completion?.timeoutMinutes ?? 30}"></label><label class="field"><span>检查间隔（秒）</span><input name="completionPollSeconds" type="number" min="5" max="60" value="${task.completion?.pollSeconds ?? 15}"></label><label class="field"><span>连续失败自动暂停</span><input name="autoPauseAfter" type="number" min="0" max="20" value="${task.failurePolicy?.autoPauseAfter ?? 3}"><small class="field-hint">填写 0 表示不自动暂停。</small></label></div></section>
    <section class="editor-section"><div class="editor-section-title"><div><h3>发送重试</h3><p>只重试接收前的网络及服务器错误，已接收消息不会重复发送</p></div></div><div class="form-grid"><label class="field"><span>最多尝试次数</span><input name="retryAttempts" type="number" min="1" max="5" value="${task.retry.attempts}"></label><label class="field"><span>重试间隔（分钟）</span><input name="retryDelayMinutes" type="number" min="0" max="60" value="${task.retry.delaySeconds / 60}"></label></div></section>
    ${!isNew && task.promptVersions?.length ? `<section class="editor-section"><div class="editor-section-title"><div><h3>提示词历史</h3><p>最近保留 20 个版本</p></div></div><div class="history-versions">${task.promptVersions.map((version) => `<div class="version-row"><div><p>${escapeHtml(version.prompt)}</p><time>${formatDate(version.createdAt, true)}</time></div><button class="icon-button" type="button" data-restore-version="${version.id}" title="恢复此版本" aria-label="恢复此版本"><i data-lucide="rotate-ccw"></i></button></div>`).join("")}</div></section>` : ""}
    <div class="editor-footer"><div class="button-row">${isNew ? "" : `${pending ? "" : '<button class="button secondary" type="button" data-task-action="force"><i data-lucide="send-horizontal"></i><span>强制发送</span></button>'}<button class="icon-button" type="button" data-task-action="clone" title="复制任务" aria-label="复制任务"><i data-lucide="copy-plus"></i></button>`}</div><div class="button-row">${isNew ? '<button class="button secondary" type="button" data-task-action="cancel">取消</button>' : `<button class="button secondary" type="button" data-task-action="delete" ${pending ? "disabled" : ""}><i data-lucide="trash-2"></i><span>删除</span></button>`}<button class="button primary" type="submit" ${pending ? "disabled" : ""}><i data-lucide="save"></i><span>保存任务</span></button></div></div>
  </form>`;
}

function toggleHtml(name, checked, title, description) {
  return `<div class="toggle-row"><div><strong>${title}</strong><small>${description}</small></div><label class="switch"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><span></span></label></div>`;
}

function timezoneOptions(selected) {
  return ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York", "America/Los_Angeles"]
    .map((zone) => `<option value="${zone}" ${zone === selected ? "selected" : ""}>${zone}</option>`).join("");
}

function renderClientPrompt(template, taskName, timeZone) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  } catch {
    return template;
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const values = { date, iso_date: date, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, task_name: taskName || "任务名称" };
  return template.replace(/\{\{\s*(date|iso_date|time|weekday|task_name)\s*\}\}/g, (_match, key) => values[key]);
}

function parseDates(value) {
  return [...new Set(value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseTimes(value) {
  return [...new Set(String(value ?? "").split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))].sort();
}

function collectTaskForm() {
  const form = $("#task-form");
  const data = new FormData(form);
  return {
    name: data.get("name"),
    monkeyTaskId: data.get("remoteTaskId") || data.get("manualTaskId"),
    accountId: data.get("accountId"),
    enabled: data.get("enabled") === "on",
    keepAwake: data.get("keepAwake") === "on",
    dryRun: data.get("dryRun") === "on",
    dedupe: data.get("dedupe") === "on",
    prompt: data.get("prompt"),
    schedule: {
      mode: data.get("scheduleMode"),
      times: parseTimes(data.get("scheduleTimes")),
      timeZone: data.get("timeZone"),
      weekdays: data.getAll("weekday").map(Number),
      catchUp: data.get("catchUp") === "on",
      includeDates: parseDates(data.get("includeDates")),
      excludeDates: parseDates(data.get("excludeDates")),
    },
    retry: {
      attempts: Number(data.get("retryAttempts")),
      delaySeconds: Math.round(Number(data.get("retryDelayMinutes")) * 60),
    },
    completion: {
      enabled: data.get("completionEnabled") === "on",
      timeoutMinutes: Number(data.get("completionTimeoutMinutes")),
      pollSeconds: Number(data.get("completionPollSeconds")),
    },
    failurePolicy: {
      autoPauseAfter: Number(data.get("autoPauseAfter")),
    },
  };
}

function renderHistoryFilters() {
  const select = $("#log-task-filter");
  const current = select.value;
  select.innerHTML = `<option value="">全部任务</option>${state.tasks.map((task) => `<option value="${task.id}">${escapeHtml(task.name)}</option>`).join("")}`;
  select.value = current;
}

function filteredLogs() {
  const taskId = $("#log-task-filter").value;
  const status = $("#log-status-filter").value;
  return state.logs.filter((log) => (!taskId || log.taskId === taskId) && (!status || log.status === status));
}

function renderHistory() {
  const logs = filteredLogs();
  $("#history-table").innerHTML = logs.length ? `<table><thead><tr><th>时间</th><th>任务 / 账号 / 渠道</th><th>触发方式</th><th>结果</th><th>耗时</th><th>详情</th><th></th></tr></thead><tbody>${logs.map((log) => {
    const canRerun = log.taskId && ["failed", "auth-expired", "completion-timeout", "auto-paused", "quota-blocked", "cancelled"].includes(log.status) && state.tasks.some((task) => task.id === log.taskId);
    return `<tr><td>${formatDate(log.at, true)}</td><td><strong>${escapeHtml(log.taskName || log.accountName || log.notificationName || "系统")}</strong></td><td>${escapeHtml(log.trigger === "schedule" ? "定时" : log.trigger === "manual" ? "手动" : log.type === "notification" ? "通知" : "系统")}</td><td>${statusBadge(log.status)}</td><td>${formatDuration(log.durationMs)}</td><td><div class="log-detail" title="${escapeHtml(log.detail)}">${escapeHtml(log.detail)}</div></td><td>${canRerun ? `<button class="icon-button" type="button" data-rerun-task="${log.taskId}" title="重新运行" aria-label="重新运行"><i data-lucide="refresh-cw"></i></button>` : ""}</td></tr>`;
  }).join("")}</tbody></table>` : emptyState("search-x", "没有符合当前筛选条件的记录。");
  icons();
}

function renderSettings() {
  if (!state.settings || !state.overview) return;
  $("#global-enabled").checked = state.settings.enabled;
  const remoteSettings = state.settings.remoteSettings ?? { enabled: true, intervalMinutes: 10, quotaWarningPercent: 20, quotaGuardEnabled: false, quotaReservePercent: 10, quotaReserveTokens: 0 };
  $("#remote-sync-enabled").checked = remoteSettings.enabled !== false;
  $("#remote-sync-interval").value = remoteSettings.intervalMinutes;
  $("#quota-warning-percent").value = String(remoteSettings.quotaWarningPercent);
  $("#quota-guard-enabled").checked = remoteSettings.quotaGuardEnabled === true;
  $("#quota-reserve-percent").value = String(remoteSettings.quotaReservePercent ?? 10);
  $("#quota-reserve-tokens").value = String(remoteSettings.quotaReserveTokens ?? 0);
  $("#log-retention-days").value = String(state.settings.operationsSettings?.logRetentionDays ?? 90);
  $("#account-concurrency").value = String(state.settings.operationsSettings?.accountConcurrency ?? 1);
  const queued = state.overview.queue?.length ?? 0;
  $("#queue-status").textContent = queued ? `当前有 ${queued} 个任务等待账号执行槽位。` : "当前没有等待中的任务。";
  $("#cancel-queued-runs").disabled = queued === 0;
  $("#notification-list").innerHTML = state.settings.notifications.length ? state.settings.notifications.map((channel) => `<div class="notification-row"><span class="notification-icon"><i data-lucide="${notificationIcon(channel.type)}"></i></span><div class="notification-copy"><strong>${escapeHtml(channel.name)}</strong><p>${escapeHtml(notificationLabels[channel.type])} · ${channel.enabled ? "已启用" : "已暂停"} · ${channel.events.map((event) => notificationEventLabels[event] || event).join("、")}</p></div><div class="notification-actions"><button class="icon-button" type="button" data-notification-test="${channel.id}" title="发送测试" aria-label="发送测试"><i data-lucide="send"></i></button><button class="icon-button" type="button" data-notification-edit="${channel.id}" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button" type="button" data-notification-delete="${channel.id}" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></div></div>`).join("") : emptyState("bell-off", "尚未配置通知渠道。");
  const system = state.overview.system;
  $("#system-info").innerHTML = `<div><dt>Node.js</dt><dd>${escapeHtml(system.node)}</dd></div><div><dt>常驻内存</dt><dd>${system.memoryMb} MB</dd></div><div><dt>数据盘可用</dt><dd>${system.diskFreeGb === null ? "—" : `${system.diskFreeGb} GB`}</dd></div><div><dt>运行时间</dt><dd>${Math.floor(system.uptimeSeconds / 3600)} 小时 ${Math.floor(system.uptimeSeconds % 3600 / 60)} 分</dd></div>`;
  renderBackups();
}

function renderBackups() {
  const container = $("#backup-list");
  if (!state.backups.length) {
    container.innerHTML = '<p class="muted">配置发生变更后会在这里显示自动快照。</p>';
    return;
  }
  container.innerHTML = state.backups.slice(0, 10).map((backup) => {
    const counts = backup.counts;
    const detail = backup.valid
      ? `${counts.accounts} 个账号 · ${counts.tasks} 个任务 · ${counts.notifications} 个通知渠道`
      : "快照无法读取或主密钥不匹配";
    return `<div class="notification-row"><span class="notification-icon"><i data-lucide="history"></i></span><div class="notification-copy"><strong>${formatDate(backup.createdAt, true)}</strong><p>${escapeHtml(detail)}</p></div><div class="notification-actions"><button class="icon-button" type="button" data-backup-restore="${escapeHtml(backup.id)}" ${backup.valid ? "" : "disabled"} title="预览并恢复" aria-label="预览并恢复"><i data-lucide="rotate-ccw"></i></button></div></div>`;
  }).join("");
}

function backupChangeSummary(changes) {
  if (!changes.totalChanges) return "该快照与当前配置没有可见差异。";
  const groups = [
    ["账号", changes.accounts],
    ["任务", changes.tasks],
    ["通知", changes.notifications],
  ];
  const parts = groups.flatMap(([label, group]) => [
    group.added.length ? `${label}新增 ${group.added.length}` : null,
    group.removed.length ? `${label}移除 ${group.removed.length}` : null,
    group.changed.length ? `${label}修改 ${group.changed.length}` : null,
  ]).filter(Boolean);
  if (changes.settingsChanged) parts.push("系统设置变化");
  if (changes.browserBridgesChanged) parts.push("浏览器连接变化");
  return `${changes.totalChanges} 项差异：${parts.join("、")}。`;
}

function notificationIcon(type) {
  return ({ generic: "webhook", wecom: "message-circle", dingtalk: "message-square", pxyb: "message-circle", telegram: "send", bark: "smartphone", email: "mail" })[type] || "bell";
}

function openNotificationDialog(id = null) {
  const channel = id ? state.settings.notifications.find((item) => item.id === id) : null;
  state.selectedNotificationId = channel?.id ?? null;
  $("#notification-dialog-title").textContent = channel ? "编辑通知渠道" : "添加通知渠道";
  const type = channel?.type ?? "generic";
  const defaults = ["failed", "auth-expired", "session-warning", "auto-login-failed", "auto-login-recovered", "quota-low", "remote-task-error", "remote-task-missing", "sync-failed"];
  $("#notification-fields").innerHTML = `<div class="form-grid"><label class="field"><span>渠道名称</span><input name="name" maxlength="80" value="${escapeHtml(channel?.name ?? "")}" required></label><label class="field"><span>渠道类型</span><select id="notification-type" name="type" ${channel ? "disabled" : ""}>${Object.entries(notificationLabels).map(([value, label]) => `<option value="${value}" ${type === value ? "selected" : ""}>${label}</option>`).join("")}</select>${channel ? `<input type="hidden" name="type" value="${type}">` : ""}</label></div><div id="notification-type-fields"></div><div class="field"><span>通知事件</span><div class="event-check-grid">${Object.entries(notificationEventLabels).map(([event, label]) => `<label class="event-check"><input type="checkbox" name="event" value="${event}" ${(channel?.events ?? defaults).includes(event) ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("")}</div></div><div class="toggle-row"><div><strong>启用渠道</strong><small>保存后立即生效</small></div><label class="switch"><input type="checkbox" name="enabled" ${channel?.enabled !== false ? "checked" : ""}><span></span></label></div>`;
  renderNotificationTypeFields(type, channel);
  $("#notification-dialog").showModal();
  icons();
}

function renderNotificationTypeFields(type, channel) {
  const settings = channel?.settings ?? {};
  const secretHint = channel?.secretConfigured ? "留空保持现有值" : "必填";
  let html = "";
  if (["generic", "wecom", "dingtalk"].includes(type)) {
    html = `<label class="field"><span>Webhook 地址</span><span class="password-wrap"><input id="notify-secret" name="webhookUrl" type="password" placeholder="${secretHint}" ${channel ? "" : "required"}><button class="icon-button password-toggle" type="button" data-toggle-password="notify-secret" title="显示地址" aria-label="显示地址"><i data-lucide="eye"></i></button></span></label>`;
  } else if (type === "pxyb") {
    html = `<div class="form-grid"><label class="field"><span>接口地址</span><input name="endpointUrl" type="url" value="${escapeHtml(settings.endpointUrl ?? "https://pxyb.cn/api/notify")}" required></label><label class="field"><span>接收人</span><input name="touser" value="${escapeHtml(settings.touser ?? "")}" maxlength="255" placeholder="例如 zhangsan" required></label></div><label class="field"><span>API Key</span><span class="password-wrap"><input id="notify-pxyb-api-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${secretHint}" ${channel ? "" : "required"}><button class="icon-button password-toggle" type="button" data-toggle-password="notify-pxyb-api-key" title="显示 API Key" aria-label="显示 API Key"><i data-lucide="eye"></i></button></span></label>`;
  } else if (type === "telegram") {
    html = `<div class="form-grid"><label class="field"><span>Chat ID</span><input name="chatId" value="${escapeHtml(settings.chatId ?? "")}" required></label><label class="field"><span>Bot Token</span><input name="botToken" type="password" placeholder="${secretHint}" ${channel ? "" : "required"}></label></div>`;
  } else if (type === "bark") {
    html = `<div class="form-grid"><label class="field"><span>服务器地址</span><input name="serverUrl" type="url" value="${escapeHtml(settings.serverUrl ?? "https://api.day.app")}" required></label><label class="field"><span>Device Key</span><input name="deviceKey" type="password" placeholder="${secretHint}" ${channel ? "" : "required"}></label></div>`;
  } else if (type === "email") {
    html = `<div class="form-grid"><label class="field"><span>SMTP 主机</span><input name="host" value="${escapeHtml(settings.host ?? "")}" required></label><label class="field"><span>端口</span><input name="port" type="number" min="1" max="65535" value="${settings.port ?? 465}" required></label><label class="field"><span>用户名</span><input name="user" value="${escapeHtml(settings.user ?? "")}" required></label><label class="field"><span>密码</span><input name="password" type="password" placeholder="${secretHint}" ${channel ? "" : "required"}></label><label class="field"><span>发件人</span><input name="from" value="${escapeHtml(settings.from ?? "")}" required></label><label class="field"><span>收件人</span><input name="to" value="${escapeHtml(settings.to ?? "")}" required></label></div><div class="toggle-row"><div><strong>SSL/TLS</strong><small>通常 465 端口启用</small></div><label class="switch"><input type="checkbox" name="secure" ${settings.secure !== false ? "checked" : ""}><span></span></label></div>`;
  }
  $("#notification-type-fields").innerHTML = html;
  icons();
}

function collectNotificationForm() {
  const form = $("#notification-form");
  const data = new FormData(form);
  const type = data.get("type");
  const payload = {
    name: data.get("name"), type, enabled: data.get("enabled") === "on", events: data.getAll("event"), settings: {}, secret: {},
  };
  if (["generic", "wecom", "dingtalk"].includes(type)) payload.secret.webhookUrl = data.get("webhookUrl");
  if (type === "pxyb") {
    payload.settings = { endpointUrl: data.get("endpointUrl"), touser: data.get("touser") };
    payload.secret.apiKey = data.get("apiKey");
  }
  if (type === "telegram") { payload.settings.chatId = data.get("chatId"); payload.secret.botToken = data.get("botToken"); }
  if (type === "bark") { payload.settings.serverUrl = data.get("serverUrl"); payload.secret.deviceKey = data.get("deviceKey"); }
  if (type === "email") {
    payload.settings = { host: data.get("host"), port: Number(data.get("port")), secure: data.get("secure") === "on", user: data.get("user"), from: data.get("from"), to: data.get("to") };
    payload.secret.password = data.get("password");
  }
  return payload;
}

async function confirmAction(title, message, buttonText = "确认") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-submit").textContent = buttonText;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

function showPage(page) {
  if (!pageMeta[page]) return;
  state.page = page;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $$(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${page}`));
  const [title, eyebrow] = pageMeta[page];
  $("#page-title").textContent = title;
  $("#page-eyebrow").textContent = eyebrow;
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  const primary = $("#primary-action");
  if (page === "overview" || page === "tasks") {
    primary.hidden = false;
    primary.title = "新建任务";
    primary.setAttribute("aria-label", "新建任务");
    primary.innerHTML = '<i data-lucide="plus"></i><span>新建任务</span>';
  } else if (page === "accounts") {
    primary.hidden = false;
    primary.title = "添加账号";
    primary.setAttribute("aria-label", "添加账号");
    primary.innerHTML = '<i data-lucide="user-plus"></i><span>添加账号</span>';
  } else if (page === "deployments") {
    primary.hidden = false;
    primary.title = "新建部署任务";
    primary.setAttribute("aria-label", "新建部署任务");
    primary.innerHTML = '<i data-lucide="rocket"></i><span>新建部署</span>';
  } else if (page === "settings") {
    primary.hidden = false;
    primary.title = "添加通知";
    primary.setAttribute("aria-label", "添加通知");
    primary.innerHTML = '<i data-lucide="bell-plus"></i><span>添加通知</span>';
  } else {
    primary.hidden = true;
    primary.removeAttribute("title");
    primary.removeAttribute("aria-label");
  }
  icons();
}

async function saveTask(event) {
  event.preventDefault();
  try {
    const payload = collectTaskForm();
    const response = await api(state.newTask ? "/api/tasks" : `/api/tasks/${state.selectedTaskId}`, {
      method: state.newTask ? "POST" : "PUT", body: payload,
    });
    state.selectedTaskId = response.task.id;
    state.newTask = false;
    state.newTaskSeed = null;
    state.taskFormDirty = false;
    await loadData();
    toast("任务配置已保存");
  } catch (error) { toast(error.message, "error"); }
}

async function runTask(mode) {
  const task = selectedTask();
  if (!task?.id) return;
  if (mode === "check") {
    try {
      await api(`/api/tasks/${task.id}/check-session`, { method: "POST" });
      toast("登录凭证有效");
      await loadData();
    } catch (error) { toast(error.message, "error"); }
    return;
  }
  const messages = {
    send: ["立即发送", "将按当前提示词向 MonkeyCode 发送一次消息，并保留防重复检查。", "发送"],
    force: ["强制发送", "将跳过远端历史与本地状态检查，可能产生重复消息。", "强制发送"],
  };
  if (mode !== "dry-run") {
    const confirmed = await confirmAction(...messages[mode]);
    if (!confirmed) return;
  }
  try {
    const response = await api(`/api/tasks/${task.id}/run`, { method: "POST", body: { mode } });
    toast(response.accepted ? (response.queued ? "任务已进入账号等待队列" : "任务已开始，结果稍后显示在执行记录中") : "该任务正在运行或等待", response.accepted ? "success" : "error");
    setTimeout(() => loadData().catch(() => {}), 1800);
  } catch (error) { toast(error.message, "error"); }
}

function exportCsv() {
  const rows = [["时间", "任务/账号", "触发方式", "模式", "结果", "尝试次数", "耗时毫秒", "详情"], ...filteredLogs().map((log) => [log.at, log.taskName || log.accountName || log.notificationName || "", log.trigger || log.type, log.mode || "", log.status, log.attempts || "", log.durationMs || "", log.detail || ""])];
  const csv = `\ufeff${rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n")}`;
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `monkeycode-runs-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-page], [data-page-link]");
  if (nav) {
    showPage(nav.dataset.page || nav.dataset.pageLink);
    loadData().catch((error) => toast(error.message, "error"));
  }

  const deploymentView = event.target.closest("[data-deployment-view]");
  if (deploymentView) setDeploymentView(deploymentView.dataset.deploymentView);
  const deploymentDetail = event.target.closest("[data-deployment-job-detail]");
  if (deploymentDetail) openDeploymentDetail(deploymentDetail.dataset.deploymentJobDetail);
  const cancelDeployment = event.target.closest("[data-cancel-deployment-job]");
  if (cancelDeployment && await confirmAction("取消部署任务", "该任务仍在排队，取消后不会分配给 Worker。", "取消任务")) {
    try {
      await api(`/api/node-pool/jobs/${encodeURIComponent(cancelDeployment.dataset.cancelDeploymentJob)}/cancel`, { method: "POST", body: {} });
      await loadData();
      toast("部署任务已取消");
    } catch (error) { toast(error.message, "error"); }
  }
  const deleteDeploymentWorker = event.target.closest("[data-delete-deployment-worker]");
  if (deleteDeploymentWorker) {
    const nodeId = deleteDeploymentWorker.dataset.deleteDeploymentWorker;
    const worker = state.nodePool.workers?.find((entry) => entry.id === nodeId);
    const message = `确定删除节点“${nodeId}”吗？节点凭证将立即失效，且不会再参与调度。该操作不会停止节点内已经运行的项目。${worker?.online ? " 当前节点在线，删除后 Worker 会断开。" : ""}`;
    if (await confirmAction("删除节点", message, "删除节点")) {
      try {
        await api(`/api/node-pool/workers/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
        await loadData();
        toast("节点已删除");
      } catch (error) { toast(error.message, "error"); }
    }
  }
  const copyDeployment = event.target.closest("[data-copy-target]");
  if (copyDeployment) copyDeploymentValue(copyDeployment.dataset.copyTarget);

  const openTask = event.target.closest("[data-open-task]");
  if (openTask) {
    state.taskFormDirty = false; state.newTask = false; state.selectedTaskId = openTask.dataset.openTask; showPage("tasks"); renderTaskList(); renderTaskEditor(); icons();
  }
  const selectTask = event.target.closest("[data-select-task]");
  if (selectTask) { state.taskFormDirty = false; state.newTask = false; state.selectedTaskId = selectTask.dataset.selectTask; renderTaskList(); renderTaskEditor(); icons(); }

  const alertAccount = event.target.closest("[data-alert-account]");
  if (alertAccount) {
    showPage("remote");
    $("#remote-account-filter").value = alertAccount.dataset.alertAccount;
    renderRemoteTasks();
    icons();
  }

  const remoteRow = event.target.closest("[data-remote-task]");
  if (remoteRow) {
    state.selectedRemoteKey = remoteRow.dataset.remoteTask;
    renderRemoteTasks();
    icons();
  }
  if (event.target.closest("[data-remote-refresh-detail]")) refreshRemoteDetail();
  if (event.target.closest("[data-use-remote-task]")) {
    const task = selectedRemoteTask();
    if (task) {
      state.newTaskSeed = { accountId: task.accountId, remoteTaskId: task.id, name: task.name };
      state.newTask = true;
      state.selectedTaskId = null;
      state.taskFormDirty = false;
      showPage("tasks");
      renderTaskList();
      renderTaskEditor();
      icons();
    }
  }

  if (event.target.closest("[data-add-account-from-task]")) openAccountDialog(null, { returnToTask: true });
  const editAccount = event.target.closest("[data-account-edit]");
  if (editAccount) openAccountDialog(editAccount.dataset.accountEdit);
  const bridgeAccount = event.target.closest("[data-account-bridge]");
  if (bridgeAccount) openBrowserBridgeDialog(bridgeAccount.dataset.accountBridge);
  const syncAccount = event.target.closest("[data-account-sync]");
  if (syncAccount) syncRemoteAccount(syncAccount.dataset.accountSync);
  const renewAccount = event.target.closest("[data-account-renew]");
  if (renewAccount) renewAccountSession(renewAccount.dataset.accountRenew);
  if (event.target.closest("[data-task-sync-remote]")) {
    const accountId = $("#task-form")?.elements.accountId?.value;
    if (accountId) syncRemoteAccount(accountId, { preserveTaskForm: true });
  }
  const checkAccount = event.target.closest("[data-account-check]");
  if (checkAccount) {
    try {
      const result = await api(`/api/accounts/${checkAccount.dataset.accountCheck}/check-session`, { method: "POST" });
      toast(result.user?.name ? `Cookie 有效，当前用户：${result.user.name}` : "Cookie 验证有效");
      await loadData();
    } catch (error) { toast(error.message, "error"); await loadData().catch(() => {}); }
  }

  if (event.target.closest("[data-bridge-generate]")) generateBridgePairCode();
  if (event.target.closest("[data-copy-pair-code]") && state.bridgePairCode?.code) {
    try {
      await navigator.clipboard.writeText(state.bridgePairCode.code);
      toast("配对码已复制");
    } catch {
      toast("复制失败，请手动选择配对码", "error");
    }
  }
  const revokeBridge = event.target.closest("[data-bridge-revoke]");
  if (revokeBridge && await confirmAction("断开浏览器", "该设备将不能继续同步 Cookie，需要重新配对后才能恢复。", "断开")) {
    try {
      await api(`/api/browser-bridge/${revokeBridge.dataset.bridgeRevoke}`, { method: "DELETE" });
      await loadData();
      toast("浏览器连接已断开");
    } catch (error) { toast(error.message, "error"); }
  }
  const deleteAccount = event.target.closest("[data-account-delete]");
  if (deleteAccount) {
    const account = state.accounts.find((item) => item.id === deleteAccount.dataset.accountDelete);
    const message = account?.taskCount
      ? `“${account.name}”仍关联 ${account.taskCount} 个任务，请先修改这些任务的账号。`
      : `确定删除“${account?.name ?? "该账号"}”吗？已保存的 Cookie 和登录凭据会一并删除。`;
    if (await confirmAction(account?.taskCount ? "账号仍在使用" : "删除账号", message, account?.taskCount ? "知道了" : "删除")) {
      if (!account?.taskCount) {
        try { await api(`/api/accounts/${account.id}`, { method: "DELETE" }); await loadData(); toast("账号已删除"); } catch (error) { toast(error.message, "error"); }
      }
    }
  }

  const passwordToggle = event.target.closest("[data-toggle-password]");
  if (passwordToggle) {
    const input = $(`#${passwordToggle.dataset.togglePassword}`);
    input.type = input.type === "password" ? "text" : "password";
    passwordToggle.innerHTML = `<i data-lucide="${input.type === "password" ? "eye" : "eye-off"}"></i>`;
    icons();
  }

  const variable = event.target.closest("[data-variable]");
  if (variable) {
    const input = $("#prompt-input");
    const start = input.selectionStart; const end = input.selectionEnd;
    input.setRangeText(variable.dataset.variable, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  }

  const taskAction = event.target.closest("[data-task-action]")?.dataset.taskAction;
  if (taskAction === "cancel") { state.taskFormDirty = false; state.newTask = false; state.newTaskSeed = null; renderTaskList(); renderTaskEditor(); icons(); }
  if (["check", "dry-run", "send", "force"].includes(taskAction)) runTask(taskAction);
  if (taskAction === "stop") {
    const task = selectedTask();
    if (task && await confirmAction("停止本次运行", task.queued ? "该任务将从等待队列中移除。" : "将停止本地请求和完成状态等待；远端已接收的消息无法撤回。", "停止")) {
      try {
        await api(`/api/tasks/${task.id}/cancel`, { method: "POST" });
        await loadData();
        toast("停止请求已处理");
      } catch (error) { toast(error.message, "error"); }
    }
  }
  if (taskAction === "clone") {
    const task = selectedTask();
    if (task && await confirmAction("复制任务", `将创建“${task.name}”的停用副本，账号和提示词保持不变。`, "复制")) {
      try {
        const response = await api(`/api/tasks/${task.id}/clone`, { method: "POST" });
        state.selectedTaskId = response.task.id;
        await loadData();
        toast("任务副本已创建");
      } catch (error) { toast(error.message, "error"); }
    }
  }
  if (taskAction === "delete") {
    const task = selectedTask();
    if (await confirmAction("删除任务", `确定删除“${task.name}”吗？执行记录仍会保留。`, "删除")) {
      try { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); state.selectedTaskId = null; await loadData(); toast("任务已删除"); } catch (error) { toast(error.message, "error"); }
    }
  }

  const restore = event.target.closest("[data-restore-version]");
  if (restore && await confirmAction("恢复提示词", "当前提示词会自动进入历史版本。", "恢复")) {
    try { await api(`/api/tasks/${state.selectedTaskId}/restore-prompt`, { method: "POST", body: { versionId: restore.dataset.restoreVersion } }); await loadData(); toast("提示词版本已恢复"); } catch (error) { toast(error.message, "error"); }
  }

  const rerun = event.target.closest("[data-rerun-task]");
  if (rerun) {
    const task = state.tasks.find((item) => item.id === rerun.dataset.rerunTask);
    if (task && await confirmAction("重新运行", `将立即重新运行“${task.name}”，并保留防重复检查。`, "运行")) {
      try {
        const response = await api(`/api/tasks/${task.id}/run`, { method: "POST", body: { mode: "send" } });
        toast(response.accepted ? (response.queued ? "任务已进入账号等待队列" : "任务已重新开始") : "该任务正在运行或等待", response.accepted ? "success" : "error");
        setTimeout(() => loadData().catch(() => {}), 1800);
      } catch (error) { toast(error.message, "error"); }
    }
  }

  const restoreBackup = event.target.closest("[data-backup-restore]");
  if (restoreBackup) {
    try {
      const response = await api(`/api/backups/${encodeURIComponent(restoreBackup.dataset.backupRestore)}`);
      const summary = backupChangeSummary(response.backup.changes);
      const confirmed = await confirmAction("恢复配置快照", `${summary} 当前配置会先自动生成一个新快照。`, "恢复");
      if (confirmed) {
        await api(`/api/backups/${encodeURIComponent(restoreBackup.dataset.backupRestore)}/restore`, { method: "POST" });
        state.selectedTaskId = null;
        state.taskFormDirty = false;
        await loadData();
        toast("配置快照已恢复");
      }
    } catch (error) { toast(error.message, "error"); }
  }

  if (event.target.closest("#add-notification") || (event.target.closest("#primary-action") && state.page === "settings")) openNotificationDialog();
  const editNotification = event.target.closest("[data-notification-edit]");
  if (editNotification) openNotificationDialog(editNotification.dataset.notificationEdit);
  const testNotification = event.target.closest("[data-notification-test]");
  if (testNotification) {
    try { await api(`/api/notifications/${testNotification.dataset.notificationTest}/test`, { method: "POST" }); toast("测试通知已发送"); } catch (error) { toast(error.message, "error"); }
  }
  const deleteNotification = event.target.closest("[data-notification-delete]");
  if (deleteNotification && await confirmAction("删除通知渠道", "删除后不会再向该渠道发送提醒。", "删除")) {
    try { await api(`/api/notifications/${deleteNotification.dataset.notificationDelete}`, { method: "DELETE" }); await loadData(); toast("通知渠道已删除"); } catch (error) { toast(error.message, "error"); }
  }

  const closeDialog = event.target.closest("[data-close-dialog]");
  if (closeDialog) $(`#${closeDialog.dataset.closeDialog}`).close();
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-remote-task]");
  if (row && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    state.selectedRemoteKey = row.dataset.remoteTask;
    renderRemoteTasks();
    icons();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest?.("#task-form")) state.taskFormDirty = true;
  if (event.target.closest?.("#remote-settings-form, #operations-settings-form")) state.settingsFormDirty = true;
  if (event.target.id === "prompt-input") {
    const task = selectedTask();
    $("#prompt-count").textContent = `${Array.from(event.target.value).length} 字`;
    $("#prompt-preview").textContent = renderClientPrompt(event.target.value, $("#task-form [name=name]").value, $("#task-form [name=timeZone]").value);
  }
  if (event.target.name === "manualTaskId" && $("#task-form")) {
    const select = $("#task-form").elements.remoteTaskId;
    if (select) select.value = "";
    $("#task-remote-summary").innerHTML = remoteTaskCompactHtml(null);
    icons();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.closest?.("#task-form")) state.taskFormDirty = true;
  if (event.target.closest?.("#remote-settings-form, #operations-settings-form")) state.settingsFormDirty = true;
  if (event.target.name === "scheduleMode") {
    const custom = event.target.value === "custom";
    $("#weekday-field").classList.toggle("muted", !custom);
  }
  if (["timeZone", "name"].includes(event.target.name) && $("#prompt-input")) $("#prompt-input").dispatchEvent(new Event("input", { bubbles: true }));
  if (event.target.name === "accountId" && $("#task-form")) {
    const account = state.accounts.find((item) => item.id === event.target.value);
    $("#remote-task-picker").outerHTML = remoteTaskPickerHtml(event.target.value, "");
    const [badgeClass, badgeText] = credentialBadgeSpec(account?.credentialStatus);
    $("#task-account-hint").innerHTML = `<span class="badge ${badgeClass}">${badgeText}</span>${account ? ` ${escapeHtml(account.name)}` : " 任务保存前必须选择账号"}`;
    icons();
  }
  if (event.target.name === "remoteTaskId" && $("#task-form")) {
    const accountId = $("#task-form").elements.accountId.value;
    const task = remoteTaskFor(accountId, event.target.value);
    $("#task-form").elements.manualTaskId.value = event.target.value;
    $("#task-remote-summary").innerHTML = remoteTaskCompactHtml(task);
    const nameInput = $("#task-form").elements.name;
    if (task && state.newTask && !nameInput.value.trim()) nameInput.value = task.name;
    icons();
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const response = await api("/api/auth/login", { method: "POST", body: { password: $("#login-password").value } });
    state.csrf = response.csrf;
    showApp();
    const targetPage = location.hash.slice(1);
    showPage(pageMeta[targetPage] ? targetPage : "overview");
    await loadData();
  } catch (error) { $("#login-error").textContent = error.message === "invalid-password" ? "密码错误" : error.message; }
});

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* session may already be gone */ }
  state.csrf = ""; showLogin();
});

$("#refresh-button").addEventListener("click", () => loadData().then(() => toast("数据已刷新")).catch((error) => toast(error.message, "error")));
$("#primary-action").addEventListener("click", () => {
  if (state.page === "settings") return;
  if (state.page === "accounts") { openAccountDialog(); return; }
  if (state.page === "deployments") { openDeploymentJobDialog(); return; }
  state.taskFormDirty = false; state.newTaskSeed = null; state.newTask = true; state.selectedTaskId = null; showPage("tasks"); renderTaskList(); renderTaskEditor(); icons();
});
$("#issue-worker-token").addEventListener("click", openWorkerTokenDialog);
$("#deployment-worker-search").addEventListener("input", () => { renderDeploymentWorkers(); icons(); });
[$("#deployment-job-search"), $("#deployment-job-status"), $("#deployment-job-type")].forEach((element) => element.addEventListener("input", () => { renderDeploymentJobs(); icons(); }));
$("#deployment-job-form").addEventListener("change", (event) => { if (event.target.name === "type") syncDeploymentJobType(); });
$("#deployment-job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const body = {
    type: data.type,
    project: data.project.trim(),
    ref: data.type === "deploy" ? data.ref.trim() : undefined,
    preferredWorkerId: data.preferredWorkerId || undefined,
    priority: Number(data.priority),
    requirements: {
      cpu: Number(data.cpu),
      memoryMb: Number(data.memoryMb),
      labels: data.labels.split(",").map((item) => item.trim()).filter(Boolean),
    },
  };
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api("/api/node-pool/jobs", { method: "POST", body });
    $("#deployment-job-dialog").close();
    await loadData();
    setDeploymentView("jobs", false);
    toast("部署任务已进入调度队列");
  } catch (error) { toast(error.message, "error"); }
  finally { submit.disabled = false; }
});
$("#worker-token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const formData = new FormData(form);
    const publicUrlTemplate = publicUrlTemplateFromSample(formData.get("publicUrlSample"));
    const result = await api("/api/node-pool/workers/token", { method: "POST", body: { nodeId: formData.get("nodeId").trim() } });
    $("#worker-token-value").value = result.token;
    $("#worker-bundle-url").value = result.bundleUrl;
    $("#worker-install-command").value = workerInstallCommand({ ...result, publicUrlTemplate });
    $("#worker-token-result").hidden = false;
    icons();
  } catch (error) { toast(error.message, "error"); }
  finally { submit.disabled = false; }
});
$("#add-task-icon").addEventListener("click", () => { state.taskFormDirty = false; state.newTaskSeed = null; state.newTask = true; state.selectedTaskId = null; renderTaskList(); renderTaskEditor(); icons(); });
$("#task-editor").addEventListener("submit", saveTask);
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = state.selectedAccountId;
    const response = await api(id ? `/api/accounts/${id}` : "/api/accounts", {
      method: id ? "PUT" : "POST",
      body: collectAccountForm(),
    });
    $("#account-dialog").close();
    if (state.accountDialogReturnToTask && !id && $("#task-form [name=accountId]")) {
      state.accounts.push(response.account);
      $("#nav-account-count").textContent = state.accounts.length;
      const select = $("#task-form [name=accountId]");
      select.insertAdjacentHTML("beforeend", `<option value="${response.account.id}">${escapeHtml(response.account.name)}</option>`);
      select.value = response.account.id;
      renderAccounts();
      icons();
    } else {
      await loadData();
    }
    state.accountDialogReturnToTask = false;
    toast("账号已保存");
    if (response.account.autoLoginEnabled && ["missing", "expired", "invalid"].includes(response.account.credentialStatus)) renewAccountSession(response.account.id);
    else if (response.account.sessionConfigured) syncRemoteAccount(response.account.id, { preserveTaskForm: true });
  } catch (error) { toast(error.message, "error"); }
});
$("#remote-account-filter").addEventListener("change", () => { state.selectedRemoteKey = null; renderRemoteTasks(); icons(); });
$("#remote-status-filter").addEventListener("change", () => { state.selectedRemoteKey = null; renderRemoteTasks(); icons(); });
$("#remote-search").addEventListener("input", () => { state.selectedRemoteKey = null; renderRemoteTasks(); icons(); });
$("#sync-all-remote").addEventListener("click", async () => {
  const button = $("#sync-all-remote");
  button.disabled = true;
  button.classList.add("is-spinning");
  try {
    const response = await api("/api/remote-sync", { method: "POST" });
    await loadData();
    const failed = response.results.filter((result) => !result.ok).length;
    toast(failed ? `同步完成，${failed} 个账号失败` : "全部账号同步完成", failed ? "error" : "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-spinning");
  }
});
$("#log-task-filter").addEventListener("change", renderHistory);
$("#log-status-filter").addEventListener("change", renderHistory);
$("#export-logs").addEventListener("click", exportCsv);
$("#clear-logs").addEventListener("click", async () => {
  if (!await confirmAction("清理执行记录", "所有任务和通知记录都会被清空，此操作不会删除配置。", "清理")) return;
  try { await api("/api/logs", { method: "DELETE" }); await loadData(); toast("执行记录已清空"); } catch (error) { toast(error.message, "error"); }
});

$("#global-enabled").addEventListener("change", async (event) => {
  try { await api("/api/settings", { method: "PUT", body: { enabled: event.target.checked } }); await loadData(); toast(event.target.checked ? "全局调度已启用" : "全局调度已暂停"); } catch (error) { event.target.checked = !event.target.checked; toast(error.message, "error"); }
});

$("#remote-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await api("/api/settings", {
      method: "PUT",
      body: {
        remoteSettings: {
          enabled: form.get("enabled") === "on",
          intervalMinutes: Number(form.get("intervalMinutes")),
          quotaWarningPercent: Number(form.get("quotaWarningPercent")),
          quotaGuardEnabled: form.get("quotaGuardEnabled") === "on",
          quotaReservePercent: Number(form.get("quotaReservePercent")),
          quotaReserveTokens: Number(form.get("quotaReserveTokens")),
        },
      },
    });
    state.settings.remoteSettings = response.remoteSettings;
    state.settingsFormDirty = false;
    renderSettings();
    icons();
    toast("远端同步设置已保存");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#operations-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await api("/api/settings", {
      method: "PUT",
      body: { operationsSettings: {
        logRetentionDays: Number(form.get("logRetentionDays")),
        accountConcurrency: Number(form.get("accountConcurrency")),
      } },
    });
    state.settings.operationsSettings = response.operationsSettings;
    state.settingsFormDirty = false;
    renderSettings();
    toast("执行队列与运行记录设置已保存");
  } catch (error) { toast(error.message, "error"); }
});

$("#cancel-queued-runs").addEventListener("click", async () => {
  const queued = state.overview?.queue?.length ?? 0;
  if (!queued || !await confirmAction("清空等待队列", `将取消 ${queued} 个尚未开始的任务，正在运行的任务不受影响。`, "清空")) return;
  try {
    const result = await api("/api/runs/queue", { method: "DELETE" });
    await loadData();
    toast(`已取消 ${result.cancelled} 个等待任务`);
  } catch (error) { toast(error.message, "error"); }
});

$("#notification-type");
$("#notification-dialog").addEventListener("change", (event) => {
  if (event.target.id === "notification-type") renderNotificationTypeFields(event.target.value, null);
});
$("#notification-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = state.selectedNotificationId;
    await api(id ? `/api/notifications/${id}` : "/api/notifications", { method: id ? "PUT" : "POST", body: collectNotificationForm() });
    $("#notification-dialog").close(); await loadData(); toast("通知渠道已保存");
  } catch (error) { toast(error.message, "error"); }
});

$("#export-backup").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/backup/export", { credentials: "same-origin" });
    if (!response.ok) throw new Error("备份导出失败");
    downloadBlob(await response.blob(), `monkeycode-backup-${new Date().toISOString().slice(0, 10)}.json`);
  } catch (error) { toast(error.message, "error"); }
});
$("#import-backup").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!await confirmAction("导入配置备份", "现有配置会先自动备份，然后被导入内容替换。加密数据必须使用相同主密钥。", "导入")) return;
  try { await api("/api/backup/import", { method: "POST", body: JSON.parse(await file.text()) }); await loadData(); toast("配置备份已导入"); } catch (error) { toast(error.message, "error"); }
});

async function boot() {
  icons();
  try {
    const auth = await api("/api/auth/status");
    if (!auth.authenticated) { showLogin(); return; }
    state.csrf = auth.csrf;
    showApp();
    const initialPage = location.hash.slice(1);
    showPage(pageMeta[initialPage] ? initialPage : "overview");
    await loadData();
  } catch (error) {
    showLogin();
    $("#login-error").textContent = error.message;
  }
}

setInterval(() => {
  if (!$("#app").hidden && !document.hidden) loadData().catch(() => {});
}, 20_000);

boot();
