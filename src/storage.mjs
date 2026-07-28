import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors.mjs";
import { decryptJson, encryptJson } from "./security.mjs";
import { validateTimeZone } from "./schedule.mjs";

const TASK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COOKIE = /^[A-Za-z0-9._~-]+$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const BRIDGE_STATUSES = new Set(["connected", "valid", "invalid", "account-mismatch"]);

function cleanText(value, name, max, { required = true } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new ConfigError(`${name} is required`);
  if (text.length > max) throw new ConfigError(`${name} is too long`);
  return text;
}

function cleanBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function cleanInteger(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function cleanDateList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((entry) => DATE.test(entry)))].sort().slice(0, 366);
}

function cleanTimes(input = {}) {
  const source = Array.isArray(input.times) ? input.times : [input.time];
  const provided = source.filter((value) => value !== undefined && value !== null && String(value).trim());
  if (provided.some((value) => typeof value !== "string" || !TIME.test(value))) {
    throw new ConfigError("Schedule times must use HH:mm format");
  }
  const times = [...new Set(provided)].sort();
  if (times.length > 12) throw new ConfigError("A schedule supports at most 12 times");
  return times.length ? times : ["09:00"];
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value || "https://monkeycode-ai.com");
  } catch {
    throw new ConfigError("Base URL is invalid");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new ConfigError("Base URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new ConfigError("Base URL contains unsupported parts");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateEndpointUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("Webhook URL is invalid");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new ConfigError("Webhook URL must use HTTPS");
  if (url.username || url.password || url.hash) throw new ConfigError("Webhook URL contains unsupported parts");
  return url.toString();
}

function cleanSchedule(input = {}) {
  const mode = ["daily", "weekdays", "custom"].includes(input.mode) ? input.mode : "daily";
  const times = cleanTimes(input);
  const timeZone = validateTimeZone(input.timeZone || "Asia/Shanghai");
  let weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : [1, 2, 3, 4, 5])
    .map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 7))].sort();
  if (mode !== "custom" && weekdays.length === 0) weekdays = [1, 2, 3, 4, 5];
  if (mode === "custom" && weekdays.length === 0) throw new ConfigError("Custom schedule needs at least one weekday");
  return {
    mode,
    time: times[0],
    times,
    timeZone,
    weekdays,
    catchUp: cleanBoolean(input.catchUp, true),
    includeDates: cleanDateList(input.includeDates),
    excludeDates: cleanDateList(input.excludeDates),
  };
}

function cleanCompletion(input = {}) {
  return {
    enabled: cleanBoolean(input.enabled, true),
    timeoutMinutes: cleanInteger(input.timeoutMinutes, 30, 1, 180, "Completion timeout"),
    pollSeconds: cleanInteger(input.pollSeconds, 15, 5, 60, "Completion polling interval"),
  };
}

function cleanFailurePolicy(input = {}) {
  return {
    autoPauseAfter: cleanInteger(input.autoPauseAfter, 3, 0, 20, "Automatic pause threshold"),
  };
}

function cleanOperationsSettings(input = {}) {
  return {
    logRetentionDays: cleanInteger(input.logRetentionDays, 90, 7, 365, "Log retention days"),
    maxLogEntries: cleanInteger(input.maxLogEntries, 20_000, 1_000, 100_000, "Maximum log entries"),
  };
}

function cleanRetry(input = {}) {
  return {
    attempts: cleanInteger(input.attempts, 3, 1, 5, "Retry attempts"),
    delaySeconds: cleanInteger(input.delaySeconds, 300, 0, 3600, "Retry delay"),
  };
}

function cleanEvents(events) {
  const allowed = new Set([
    "sent",
    "completed",
    "completion-timeout",
    "auto-paused",
    "failed",
    "auth-expired",
    "session-warning",
    "duplicate",
    "quota-low",
    "remote-task-error",
    "environment-hibernated",
    "remote-task-missing",
    "sync-failed",
  ]);
  const cleaned = Array.isArray(events) ? events.filter((event) => allowed.has(event)) : [];
  return [...new Set(cleaned)];
}

function cleanNotificationPublic(type, input = {}) {
  if (type === "pxyb") {
    return {
      endpointUrl: validateEndpointUrl(input.endpointUrl || "https://pxyb.cn/api/notify"),
      touser: cleanText(input.touser, "PXYB recipient", 255),
    };
  }
  if (type === "telegram") {
    return { chatId: cleanText(input.chatId, "Telegram chat ID", 100) };
  }
  if (type === "bark") {
    return { serverUrl: validateBaseUrl(input.serverUrl || "https://api.day.app") };
  }
  if (type === "email") {
    return {
      host: cleanText(input.host, "SMTP host", 255),
      port: cleanInteger(input.port, 465, 1, 65535, "SMTP port"),
      secure: cleanBoolean(input.secure, true),
      user: cleanText(input.user, "SMTP user", 255),
      from: cleanText(input.from, "Email sender", 255),
      to: cleanText(input.to, "Email recipient", 1000),
    };
  }
  return {};
}

function requiredSecret(type, input = {}) {
  if (["generic", "wecom", "dingtalk"].includes(type)) {
    const webhookUrl = cleanText(input.webhookUrl, "Webhook URL", 2048);
    return { webhookUrl: validateEndpointUrl(webhookUrl) };
  }
  if (type === "pxyb") return { apiKey: cleanText(input.apiKey, "PXYB API key", 1000) };
  if (type === "telegram") return { botToken: cleanText(input.botToken, "Telegram bot token", 255) };
  if (type === "bark") return { deviceKey: cleanText(input.deviceKey, "Bark device key", 255) };
  if (type === "email") return { password: cleanText(input.password, "SMTP password", 1000) };
  throw new ConfigError("Unsupported notification type");
}

function publicNotification(notification) {
  const { secretEncrypted: _secret, ...safe } = notification;
  return { ...safe, secretConfigured: Boolean(notification.secretEncrypted) };
}

function publicBrowserBridge(bridge) {
  const { tokenHash: _tokenHash, ...safe } = bridge;
  return safe;
}

function accountCredentialStatus(account, now = Date.now()) {
  if (!account.sessionEncrypted) return "missing";
  const expiresAt = account.sessionExpiresAt ? new Date(account.sessionExpiresAt).getTime() : null;
  if (Number.isFinite(expiresAt) && expiresAt <= now) return "expired";
  if (account.lastValidationStatus === "invalid") return "invalid";
  if (Number.isFinite(expiresAt) && expiresAt - now <= 3 * 86_400_000) return "expiring";
  if (account.lastValidationStatus === "valid") return "valid";
  return "unknown";
}

export class DataStore {
  constructor(dataDir, masterKey) {
    this.dataDir = path.resolve(dataDir);
    this.masterKey = masterKey;
    this.configFile = path.join(this.dataDir, "config.json");
    this.logFile = path.join(this.dataDir, "runs.jsonl");
    this.scheduleFile = path.join(this.dataDir, "schedule-state.json");
    this.backupDir = path.join(this.dataDir, "backups");
    this.stateDir = path.join(this.dataDir, "task-state");
    this.config = null;
    this.logWrite = Promise.resolve();
    this.lastLogPruneAt = 0;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await readFile(this.configFile, "utf8"));
      this.validateEncryptedConfig(loaded);
      this.config = this.migrateConfig(loaded);
      if (loaded.version !== this.config.version) await this.writeConfig();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.config = {
        version: 8,
        enabled: true,
        remoteSettings: { enabled: true, intervalMinutes: 10, quotaWarningPercent: 20 },
        operationsSettings: cleanOperationsSettings(),
        accounts: [],
        tasks: [],
        notifications: [],
        browserBridges: [],
        updatedAt: new Date().toISOString(),
      };
      await this.writeConfig(false);
    }
    return this;
  }

  validateEncryptedConfig(config) {
    if (!config || ![2, 3, 4, 5, 6, 7, 8].includes(config.version) || !Array.isArray(config.tasks) || !Array.isArray(config.notifications)) {
      throw new ConfigError("Unsupported or invalid control panel configuration");
    }
    if (config.version === 2) {
      for (const task of config.tasks) {
        if (task.sessionEncrypted) decryptJson(task.sessionEncrypted, this.masterKey);
      }
    } else {
      if (!Array.isArray(config.accounts)) throw new ConfigError("Account configuration is invalid");
      const accountIds = new Set();
      for (const account of config.accounts) {
        if (!account.id || accountIds.has(account.id)) throw new ConfigError("Account identifiers are invalid");
        accountIds.add(account.id);
        if (account.sessionEncrypted) decryptJson(account.sessionEncrypted, this.masterKey);
      }
      for (const task of config.tasks) {
        if (task.accountId && !accountIds.has(task.accountId)) throw new ConfigError("Task references an unknown account");
      }
      if (config.version >= 4) {
        if (!Array.isArray(config.browserBridges)) throw new ConfigError("Browser bridge configuration is invalid");
        const bridgeIds = new Set();
        for (const bridge of config.browserBridges) {
          if (!bridge.id || bridgeIds.has(bridge.id) || !accountIds.has(bridge.accountId)) {
            throw new ConfigError("Browser bridge identifiers are invalid");
          }
          if (!TOKEN_HASH.test(bridge.tokenHash ?? "")) throw new ConfigError("Browser bridge token is invalid");
          if (!EXTENSION_ORIGIN.test(bridge.extensionOrigin ?? "")) throw new ConfigError("Browser bridge origin is invalid");
          if (typeof bridge.deviceId !== "string" || bridge.deviceId.length < 8 || bridge.deviceId.length > 128) {
            throw new ConfigError("Browser bridge device identifier is invalid");
          }
          if (typeof bridge.deviceName !== "string" || !bridge.deviceName.trim() || bridge.deviceName.length > 100) {
            throw new ConfigError("Browser bridge device name is invalid");
          }
          if (!BRIDGE_STATUSES.has(bridge.lastStatus)) throw new ConfigError("Browser bridge status is invalid");
          bridgeIds.add(bridge.id);
        }
      }
    }
    for (const notification of config.notifications) {
      if (notification.secretEncrypted) decryptJson(notification.secretEncrypted, this.masterKey);
    }
  }

  migrateV2(config) {
    const accounts = [];
    const tasks = config.tasks.map((legacyTask) => {
      const accountId = randomUUID();
      const {
        baseUrl,
        sessionEncrypted,
        sessionUpdatedAt,
        ...task
      } = legacyTask;
      accounts.push({
        id: accountId,
        name: `${legacyTask.name || "MonkeyCode"} 账号`,
        baseUrl: validateBaseUrl(baseUrl),
        sessionEncrypted: sessionEncrypted ?? null,
        sessionUpdatedAt: sessionUpdatedAt ?? null,
        sessionExpiresAt: null,
        sessionSource: sessionEncrypted ? "manual" : null,
        lastSyncedAt: null,
        lastValidatedAt: null,
        lastValidationStatus: "unknown",
        userId: null,
        userName: null,
        createdAt: legacyTask.createdAt ?? new Date().toISOString(),
        updatedAt: legacyTask.updatedAt ?? new Date().toISOString(),
      });
      return { ...task, accountId };
    });
    return {
      ...config,
      version: 3,
      accounts,
      tasks,
    };
  }

  migrateV3(config) {
    return {
      ...config,
      version: 4,
      accounts: config.accounts.map((account) => ({
        ...account,
        sessionExpiresAt: account.sessionExpiresAt ?? null,
        sessionSource: account.sessionSource ?? (account.sessionEncrypted ? "manual" : null),
        lastSyncedAt: account.lastSyncedAt ?? null,
      })),
      browserBridges: [],
    };
  }

  migrateV4(config) {
    return {
      ...config,
      version: 5,
      accounts: config.accounts.map((account) => ({
        ...account,
        remoteSnapshot: account.remoteSnapshot ?? null,
        remoteSyncStatus: account.remoteSyncStatus ?? "never",
        remoteSyncError: account.remoteSyncError ?? null,
        remoteSyncAttemptedAt: account.remoteSyncAttemptedAt ?? null,
        remoteSyncedAt: account.remoteSyncedAt ?? null,
      })),
    };
  }

  migrateV5(config) {
    return {
      ...config,
      version: 6,
      remoteSettings: {
        enabled: config.remoteSettings?.enabled !== false,
        intervalMinutes: Number.isInteger(config.remoteSettings?.intervalMinutes) ? config.remoteSettings.intervalMinutes : 10,
        quotaWarningPercent: Number.isInteger(config.remoteSettings?.quotaWarningPercent) ? config.remoteSettings.quotaWarningPercent : 20,
      },
    };
  }

  migrateV6(config) {
    return {
      ...config,
      version: 7,
      tasks: config.tasks.map((task) => ({
        ...task,
        keepAwake: typeof task.keepAwake === "boolean" ? task.keepAwake : Boolean(task.accountId),
      })),
    };
  }

  migrateV7(config) {
    return {
      ...config,
      version: 8,
      operationsSettings: cleanOperationsSettings(config.operationsSettings),
      tasks: config.tasks.map((task) => ({
        ...task,
        schedule: cleanSchedule(task.schedule),
        completion: cleanCompletion(task.completion ?? { enabled: false }),
        failurePolicy: cleanFailurePolicy(task.failurePolicy ?? { autoPauseAfter: 0 }),
      })),
    };
  }

  migrateConfig(config) {
    if (config.version === 2) return this.migrateV7(this.migrateV6(this.migrateV5(this.migrateV4(this.migrateV3(this.migrateV2(config))))));
    if (config.version === 3) return this.migrateV7(this.migrateV6(this.migrateV5(this.migrateV4(this.migrateV3(config)))));
    if (config.version === 4) return this.migrateV7(this.migrateV6(this.migrateV5(this.migrateV4(config))));
    if (config.version === 5) return this.migrateV7(this.migrateV6(this.migrateV5(config)));
    if (config.version === 6) return this.migrateV7(this.migrateV6(config));
    if (config.version === 7) return this.migrateV7(config);
    return config;
  }

  publicAccount(account) {
    const { sessionEncrypted: _session, ...safe } = account;
    return {
      ...safe,
      sessionConfigured: Boolean(account.sessionEncrypted),
      credentialStatus: accountCredentialStatus(account),
      taskCount: this.config.tasks.filter((task) => task.accountId === account.id).length,
      bridges: this.config.browserBridges
        .filter((bridge) => bridge.accountId === account.id && !bridge.revokedAt)
        .map(publicBrowserBridge),
    };
  }

  publicTask(task) {
    const account = this.config.accounts.find((entry) => entry.id === task.accountId);
    return {
      ...task,
      accountName: account?.name ?? null,
      baseUrl: account?.baseUrl ?? null,
      sessionConfigured: Boolean(account?.sessionEncrypted),
      sessionUpdatedAt: account?.sessionUpdatedAt ?? null,
      sessionExpiresAt: account?.sessionExpiresAt ?? null,
      sessionSource: account?.sessionSource ?? null,
      accountCredentialStatus: account ? accountCredentialStatus(account) : "missing",
      accountValidationStatus: account?.lastValidationStatus ?? "unknown",
      accountLastValidatedAt: account?.lastValidatedAt ?? null,
    };
  }

  getPublicConfig() {
    return {
      version: this.config.version,
      enabled: this.config.enabled,
      remoteSettings: structuredClone(this.config.remoteSettings),
      operationsSettings: structuredClone(this.config.operationsSettings),
      updatedAt: this.config.updatedAt,
      accounts: this.config.accounts.map((account) => this.publicAccount(account)),
      tasks: this.config.tasks.map((task) => this.publicTask(task)),
      notifications: this.config.notifications.map(publicNotification),
    };
  }

  getAccount(id, { withSession = false } = {}) {
    const account = this.config.accounts.find((entry) => entry.id === id);
    if (!account) return null;
    if (!withSession) return this.publicAccount(account);
    return {
      ...account,
      session: account.sessionEncrypted ? decryptJson(account.sessionEncrypted, this.masterKey).session : "",
    };
  }

  async upsertAccount(input, id) {
    const existingIndex = id ? this.config.accounts.findIndex((account) => account.id === id) : -1;
    if (id && existingIndex < 0) throw new ConfigError("Account not found");
    const existing = existingIndex >= 0 ? this.config.accounts[existingIndex] : null;
    const now = new Date().toISOString();
    const baseUrl = validateBaseUrl(input.baseUrl ?? existing?.baseUrl);
    let sessionEncrypted = existing?.sessionEncrypted ?? null;
    let sessionUpdatedAt = existing?.sessionUpdatedAt ?? null;
    let sessionExpiresAt = existing?.sessionExpiresAt ?? null;
    let sessionSource = existing?.sessionSource ?? null;
    let lastSyncedAt = existing?.lastSyncedAt ?? null;
    let remoteSnapshot = existing?.remoteSnapshot ?? null;
    let remoteSyncStatus = existing?.remoteSyncStatus ?? "never";
    let remoteSyncError = existing?.remoteSyncError ?? null;
    let remoteSyncAttemptedAt = existing?.remoteSyncAttemptedAt ?? null;
    let remoteSyncedAt = existing?.remoteSyncedAt ?? null;
    let credentialChanged = baseUrl !== existing?.baseUrl;

    if (input.clearSession === true) {
      credentialChanged = Boolean(sessionEncrypted) || credentialChanged;
      sessionEncrypted = null;
      sessionUpdatedAt = null;
      sessionExpiresAt = null;
      sessionSource = null;
      lastSyncedAt = null;
      remoteSnapshot = null;
      remoteSyncStatus = "never";
      remoteSyncError = null;
      remoteSyncAttemptedAt = null;
      remoteSyncedAt = null;
    } else if (typeof input.session === "string" && input.session.trim()) {
      const session = input.session.trim();
      if (!COOKIE.test(session)) throw new ConfigError("Session cookie contains invalid characters");
      sessionEncrypted = encryptJson({ session }, this.masterKey);
      sessionUpdatedAt = now;
      sessionExpiresAt = null;
      sessionSource = "manual";
      lastSyncedAt = null;
      remoteSnapshot = null;
      remoteSyncStatus = "stale";
      remoteSyncError = null;
      remoteSyncAttemptedAt = null;
      remoteSyncedAt = null;
      credentialChanged = true;
    }

    const account = {
      id: existing?.id ?? randomUUID(),
      name: cleanText(input.name, "Account name", 80),
      baseUrl,
      sessionEncrypted,
      sessionUpdatedAt,
      sessionExpiresAt,
      sessionSource,
      lastSyncedAt,
      remoteSnapshot,
      remoteSyncStatus,
      remoteSyncError,
      remoteSyncAttemptedAt,
      remoteSyncedAt,
      lastValidatedAt: credentialChanged ? null : existing?.lastValidatedAt ?? null,
      lastValidationStatus: credentialChanged ? "unknown" : existing?.lastValidationStatus ?? "unknown",
      userId: credentialChanged ? null : existing?.userId ?? null,
      userName: credentialChanged ? null : existing?.userName ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIndex >= 0) this.config.accounts[existingIndex] = account;
    else this.config.accounts.push(account);
    await this.writeConfig();
    return this.publicAccount(account);
  }

  async recordAccountValidation(id, status, user = null) {
    if (!["valid", "invalid"].includes(status)) throw new ConfigError("Account validation status is invalid");
    const account = this.config.accounts.find((entry) => entry.id === id);
    if (!account) throw new ConfigError("Account not found");
    account.lastValidatedAt = new Date().toISOString();
    account.lastValidationStatus = status;
    if (status === "valid" && user?.id) account.userId = String(user.id);
    if (status === "valid") account.userName = user?.name ?? user?.nickname ?? null;
    account.updatedAt = new Date().toISOString();
    await this.writeConfig(false);
    return this.publicAccount(account);
  }

  async recordRemoteSync(id, snapshot) {
    const account = this.config.accounts.find((entry) => entry.id === id);
    if (!account) throw new ConfigError("Account not found");
    const remoteUserId = snapshot?.profile?.id ? String(snapshot.profile.id) : "";
    if (!remoteUserId) throw new ConfigError("Remote account identity is missing");
    if (account.userId && account.userId !== remoteUserId) {
      throw new ConfigError("MonkeyCode account does not match the configured account");
    }
    const now = new Date().toISOString();
    account.userId = remoteUserId;
    account.userName = snapshot.profile.name ?? account.userName ?? null;
    account.lastValidatedAt = now;
    account.lastValidationStatus = "valid";
    account.remoteSnapshot = structuredClone(snapshot);
    account.remoteSyncStatus = "synced";
    account.remoteSyncError = null;
    account.remoteSyncAttemptedAt = now;
    account.remoteSyncedAt = now;
    account.updatedAt = now;
    await this.writeConfig(false);
    return this.publicAccount(account);
  }

  async recordRemoteSyncFailure(id, error) {
    const account = this.config.accounts.find((entry) => entry.id === id);
    if (!account) throw new ConfigError("Account not found");
    const now = new Date().toISOString();
    account.remoteSyncStatus = "error";
    account.remoteSyncError = String(error || "Remote sync failed").slice(0, 240);
    account.remoteSyncAttemptedAt = now;
    account.updatedAt = now;
    await this.writeConfig(false);
    return this.publicAccount(account);
  }

  async deleteAccount(id) {
    const index = this.config.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new ConfigError("Account not found");
    const taskCount = this.config.tasks.filter((task) => task.accountId === id).length;
    if (taskCount > 0) throw new ConfigError(`Account is used by ${taskCount} task(s)`);
    this.config.accounts.splice(index, 1);
    this.config.browserBridges = this.config.browserBridges.filter((bridge) => bridge.accountId !== id);
    await this.writeConfig();
  }

  getPublicBrowserBridge(id) {
    const bridge = this.config.browserBridges.find((entry) => entry.id === id);
    return bridge ? publicBrowserBridge(bridge) : null;
  }

  findBrowserBridge(predicate) {
    return this.config.browserBridges.find(predicate) ?? null;
  }

  async createBrowserBridge(input) {
    const account = this.config.accounts.find((entry) => entry.id === input.accountId);
    if (!account) throw new ConfigError("Account not found");
    if (!TOKEN_HASH.test(input.tokenHash ?? "")) throw new ConfigError("Browser bridge token is invalid");
    const now = new Date().toISOString();
    for (const existing of this.config.browserBridges) {
      if (
        existing.deviceId === input.deviceId
        && existing.extensionOrigin === input.extensionOrigin
        && !existing.revokedAt
      ) {
        existing.revokedAt = now;
        existing.updatedAt = now;
      }
    }
    const bridge = {
      id: randomUUID(),
      accountId: input.accountId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      extensionOrigin: input.extensionOrigin,
      tokenHash: input.tokenHash,
      lastStatus: "connected",
      lastError: null,
      lastSeenAt: now,
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    };
    this.config.browserBridges.push(bridge);
    await this.writeConfig();
    return publicBrowserBridge(bridge);
  }

  async recordBrowserBridgeStatus(id, status, error = null, options = {}) {
    const bridge = this.config.browserBridges.find((entry) => entry.id === id);
    if (!bridge) throw new ConfigError("Browser bridge not found");
    if (!BRIDGE_STATUSES.has(status)) throw new ConfigError("Browser bridge status is invalid");
    const now = new Date().toISOString();
    bridge.lastSeenAt = now;
    if (!options.seenOnly) {
      bridge.lastStatus = status;
      bridge.lastError = typeof error === "string" ? error.slice(0, 200) : null;
      bridge.updatedAt = now;
    }
    await this.writeConfig(false);
    return publicBrowserBridge(bridge);
  }

  async updateAccountSessionFromBridge(id, input) {
    const account = this.config.accounts.find((entry) => entry.id === id);
    const bridge = this.config.browserBridges.find((entry) => entry.id === input.bridgeId && entry.accountId === id && !entry.revokedAt);
    if (!account || !bridge) throw new ConfigError("Browser pairing is invalid");
    const userId = input.user?.id ? String(input.user.id) : "";
    if (!userId) throw new ConfigError("MonkeyCode user identity is missing");
    if (account.userId && account.userId !== userId) throw new ConfigError("MonkeyCode account does not match this pairing");
    const previousSession = account.sessionEncrypted ? decryptJson(account.sessionEncrypted, this.masterKey).session : "";
    const now = new Date().toISOString();
    const changed = previousSession !== input.session || account.sessionExpiresAt !== input.expiresAt;
    if (previousSession !== input.session) account.sessionEncrypted = encryptJson({ session: input.session }, this.masterKey);
    account.sessionUpdatedAt = previousSession !== input.session ? now : account.sessionUpdatedAt ?? now;
    account.sessionExpiresAt = input.expiresAt;
    account.sessionSource = "chrome-extension";
    account.lastSyncedAt = now;
    account.lastValidatedAt = now;
    account.lastValidationStatus = "valid";
    account.userId = userId;
    account.userName = input.user?.name ?? input.user?.nickname ?? null;
    account.updatedAt = now;
    bridge.lastStatus = "valid";
    bridge.lastError = null;
    bridge.lastSeenAt = now;
    bridge.lastSyncedAt = now;
    bridge.updatedAt = now;
    await this.writeConfig(changed);
    return this.publicAccount(account);
  }

  async revokeBrowserBridge(id) {
    const bridge = this.config.browserBridges.find((entry) => entry.id === id);
    if (!bridge) throw new ConfigError("Browser bridge not found");
    if (!bridge.revokedAt) {
      bridge.revokedAt = new Date().toISOString();
      bridge.updatedAt = bridge.revokedAt;
      await this.writeConfig();
    }
    return publicBrowserBridge(bridge);
  }

  getTask(id, { withSession = false } = {}) {
    const task = this.config.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    if (!withSession) return this.publicTask(task);
    const account = this.config.accounts.find((entry) => entry.id === task.accountId);
    return {
      ...task,
      accountName: account?.name ?? null,
      baseUrl: account?.baseUrl ?? null,
      session: account?.sessionEncrypted ? decryptJson(account.sessionEncrypted, this.masterKey).session : "",
      sessionExpiresAt: account?.sessionExpiresAt ?? null,
      sessionSource: account?.sessionSource ?? null,
    };
  }

  async upsertTask(input, id) {
    const existingIndex = id ? this.config.tasks.findIndex((task) => task.id === id) : -1;
    if (id && existingIndex < 0) throw new ConfigError("Task not found");
    const existing = existingIndex >= 0 ? this.config.tasks[existingIndex] : null;

    const name = cleanText(input.name, "Task name", 80);
    const monkeyTaskId = cleanText(input.monkeyTaskId, "MonkeyCode task ID", 64);
    if (!TASK_UUID.test(monkeyTaskId)) throw new ConfigError("MonkeyCode task ID must be a UUID");
    const prompt = typeof input.prompt === "string" ? input.prompt.replace(/(?:\r?\n)+$/, "") : "";
    if (!prompt.trim()) throw new ConfigError("Prompt is required");
    if (Buffer.byteLength(prompt, "utf8") > 1024 * 1024) throw new ConfigError("Prompt exceeds 1 MiB");

    let accountId = typeof input.accountId === "string" ? input.accountId.trim() || null : existing?.accountId ?? null;
    const accountIndex = accountId ? this.config.accounts.findIndex((entry) => entry.id === accountId) : -1;
    let account = accountIndex >= 0 ? { ...this.config.accounts[accountIndex] } : null;
    if (accountId && !account) throw new ConfigError("Account not found");

    const legacySession = typeof input.session === "string" ? input.session.trim() : "";
    if (!account && (legacySession || input.baseUrl)) {
      const now = new Date().toISOString();
      account = {
        id: randomUUID(),
        name: `${name} 账号`,
        baseUrl: validateBaseUrl(input.baseUrl),
        sessionEncrypted: null,
        sessionUpdatedAt: null,
        sessionExpiresAt: null,
        sessionSource: null,
        lastSyncedAt: null,
        remoteSnapshot: null,
        remoteSyncStatus: "never",
        remoteSyncError: null,
        remoteSyncAttemptedAt: null,
        remoteSyncedAt: null,
        lastValidatedAt: null,
        lastValidationStatus: "unknown",
        userId: null,
        userName: null,
        createdAt: now,
        updatedAt: now,
      };
      accountId = account.id;
    }
    if (legacySession) {
      if (!COOKIE.test(legacySession)) throw new ConfigError("Session cookie contains invalid characters");
      account.sessionEncrypted = encryptJson({ session: legacySession }, this.masterKey);
      account.sessionUpdatedAt = new Date().toISOString();
      account.sessionExpiresAt = null;
      account.sessionSource = "manual";
      account.lastSyncedAt = null;
      account.lastValidatedAt = null;
      account.lastValidationStatus = "unknown";
      account.userId = null;
      account.userName = null;
      account.updatedAt = new Date().toISOString();
    } else if (input.clearSession === true && account) {
      account.sessionEncrypted = null;
      account.sessionUpdatedAt = null;
      account.sessionExpiresAt = null;
      account.sessionSource = null;
      account.lastSyncedAt = null;
      account.lastValidatedAt = null;
      account.lastValidationStatus = "unknown";
      account.userId = null;
      account.userName = null;
      account.updatedAt = new Date().toISOString();
    }

    let promptVersions = existing?.promptVersions ?? [];
    if (existing && existing.prompt !== prompt) {
      promptVersions = [{ id: randomUUID(), prompt: existing.prompt, createdAt: new Date().toISOString() }, ...promptVersions]
        .slice(0, 20);
    }

    const enabled = cleanBoolean(input.enabled, false);
    const keepAwake = cleanBoolean(input.keepAwake, existing?.keepAwake ?? true);
    if ((enabled || keepAwake) && (!account || !account.sessionEncrypted)) {
      throw new ConfigError(`${keepAwake ? "Keep-awake" : "Enabled"} task requires an account with a session cookie`);
    }

    const task = {
      id: existing?.id ?? randomUUID(),
      name,
      monkeyTaskId,
      accountId,
      enabled,
      keepAwake,
      dryRun: cleanBoolean(input.dryRun, true),
      dedupe: cleanBoolean(input.dedupe, true),
      prompt,
      promptVersions,
      schedule: cleanSchedule(input.schedule),
      retry: cleanRetry(input.retry),
      completion: cleanCompletion(input.completion ?? existing?.completion),
      failurePolicy: cleanFailurePolicy(input.failurePolicy ?? existing?.failurePolicy),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (account) {
      if (accountIndex >= 0) this.config.accounts[accountIndex] = account;
      else this.config.accounts.push(account);
    }
    if (existingIndex >= 0) this.config.tasks[existingIndex] = task;
    else this.config.tasks.push(task);
    await this.writeConfig();
    return this.publicTask(task);
  }

  async deleteTask(id) {
    const index = this.config.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new ConfigError("Task not found");
    this.config.tasks.splice(index, 1);
    await this.writeConfig();
  }

  async cloneTask(id) {
    const source = this.config.tasks.find((task) => task.id === id);
    if (!source) throw new ConfigError("Task not found");
    const now = new Date().toISOString();
    const task = {
      ...structuredClone(source),
      id: randomUUID(),
      name: `${source.name} 副本`.slice(0, 80),
      enabled: false,
      keepAwake: false,
      promptVersions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.config.tasks.push(task);
    await this.writeConfig();
    return this.publicTask(task);
  }

  async setTaskEnabled(id, enabled) {
    const task = this.config.tasks.find((entry) => entry.id === id);
    if (!task) throw new ConfigError("Task not found");
    task.enabled = Boolean(enabled);
    task.updatedAt = new Date().toISOString();
    await this.writeConfig();
    return this.publicTask(task);
  }

  async restorePrompt(taskId, versionId) {
    const task = this.config.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new ConfigError("Task not found");
    const version = task.promptVersions.find((entry) => entry.id === versionId);
    if (!version) throw new ConfigError("Prompt version not found");
    return this.upsertTask({ ...this.publicTask(task), prompt: version.prompt }, taskId);
  }

  async setEnabled(enabled) {
    this.config.enabled = Boolean(enabled);
    await this.writeConfig();
  }

  async setRemoteSettings(input = {}) {
    const intervalMinutes = cleanInteger(input.intervalMinutes, this.config.remoteSettings?.intervalMinutes ?? 10, 1, 1440, "Remote sync interval");
    const quotaWarningPercent = cleanInteger(input.quotaWarningPercent, this.config.remoteSettings?.quotaWarningPercent ?? 20, 1, 50, "Quota warning percent");
    this.config.remoteSettings = {
      enabled: cleanBoolean(input.enabled, this.config.remoteSettings?.enabled ?? true),
      intervalMinutes,
      quotaWarningPercent,
    };
    await this.writeConfig();
    return structuredClone(this.config.remoteSettings);
  }

  async setOperationsSettings(input = {}) {
    this.config.operationsSettings = cleanOperationsSettings({ ...this.config.operationsSettings, ...input });
    await this.writeConfig();
    await this.logWrite.catch(() => {});
    this.lastLogPruneAt = Date.now();
    await this.pruneLogs();
    return structuredClone(this.config.operationsSettings);
  }

  async upsertNotification(input, id) {
    const allowedTypes = ["generic", "wecom", "dingtalk", "pxyb", "telegram", "bark", "email"];
    const type = allowedTypes.includes(input.type) ? input.type : null;
    if (!type) throw new ConfigError("Unsupported notification type");
    const existingIndex = id ? this.config.notifications.findIndex((item) => item.id === id) : -1;
    if (id && existingIndex < 0) throw new ConfigError("Notification channel not found");
    const existing = existingIndex >= 0 ? this.config.notifications[existingIndex] : null;
    if (existing && existing.type !== type) throw new ConfigError("Notification type cannot be changed");

    let secretEncrypted = existing?.secretEncrypted ?? null;
    const secretInput = input.secret ?? {};
    if (Object.values(secretInput).some((value) => typeof value === "string" && value.trim())) {
      secretEncrypted = encryptJson(requiredSecret(type, secretInput), this.masterKey);
    }
    if (!secretEncrypted) throw new ConfigError("Notification credentials are required");

    const notification = {
      id: existing?.id ?? randomUUID(),
      name: cleanText(input.name, "Notification name", 80),
      type,
      enabled: cleanBoolean(input.enabled, true),
      events: cleanEvents(input.events),
      settings: cleanNotificationPublic(type, input.settings),
      secretEncrypted,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (notification.events.length === 0) throw new ConfigError("Select at least one notification event");

    if (existingIndex >= 0) this.config.notifications[existingIndex] = notification;
    else this.config.notifications.push(notification);
    await this.writeConfig();
    return publicNotification(notification);
  }

  getNotification(id, { withSecret = false } = {}) {
    const item = this.config.notifications.find((entry) => entry.id === id);
    if (!item) return null;
    if (!withSecret) return publicNotification(item);
    return {
      ...item,
      secret: decryptJson(item.secretEncrypted, this.masterKey),
    };
  }

  listNotificationsWithSecrets() {
    return this.config.notifications.map((item) => ({
      ...item,
      secret: decryptJson(item.secretEncrypted, this.masterKey),
    }));
  }

  async deleteNotification(id) {
    const index = this.config.notifications.findIndex((item) => item.id === id);
    if (index < 0) throw new ConfigError("Notification channel not found");
    this.config.notifications.splice(index, 1);
    await this.writeConfig();
  }

  async appendLog(entry) {
    const line = `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry })}\n`;
    this.logWrite = this.logWrite.catch(() => {}).then(async () => {
      await writeFile(this.logFile, line, { encoding: "utf8", flag: "a", mode: 0o600 });
      if (Date.now() - this.lastLogPruneAt >= 6 * 60 * 60_000) {
        this.lastLogPruneAt = Date.now();
        await this.pruneLogs();
      }
    });
    return this.logWrite;
  }

  async pruneLogs() {
    let content;
    try {
      content = await readFile(this.logFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const settings = this.config.operationsSettings ?? cleanOperationsSettings();
    const cutoff = Date.now() - settings.logRetentionDays * 86_400_000;
    const lines = content.trim().split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
      try { return new Date(JSON.parse(line).at).getTime() >= cutoff; } catch { return false; }
    }).slice(-settings.maxLogEntries);
    if (kept.length === lines.length) return;
    const temporary = `${this.logFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.logFile);
  }

  async readLogs({ limit = 200, taskId, status } = {}) {
    let content;
    try {
      content = await readFile(this.logFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return content.trim().split("\n").filter(Boolean).reverse().map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((entry) => entry && (!taskId || entry.taskId === taskId) && (!status || entry.status === status)).slice(0, limit);
  }

  async clearLogs() {
    this.logWrite = this.logWrite.catch(() => {}).then(() => writeFile(this.logFile, "", { encoding: "utf8", mode: 0o600 }));
    return this.logWrite;
  }

  async readScheduleState() {
    try {
      return JSON.parse(await readFile(this.scheduleFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async writeScheduleState(state) {
    await this.atomicWrite(this.scheduleFile, state);
  }

  taskStateFile(taskId) {
    return path.join(this.stateDir, `${taskId}.json`);
  }

  async exportConfig() {
    return { ...structuredClone(this.config), browserBridges: [] };
  }

  async importConfig(config) {
    this.validateEncryptedConfig(config);
    this.config = this.migrateConfig(structuredClone(config));
    this.config.updatedAt = new Date().toISOString();
    await this.writeConfig();
    return this.getPublicConfig();
  }

  async writeConfig(backup = true) {
    if (backup) await this.backupCurrentConfig();
    this.config.updatedAt = new Date().toISOString();
    await this.atomicWrite(this.configFile, this.config);
  }

  async atomicWrite(filename, value) {
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  }

  async backupCurrentConfig() {
    let current;
    try {
      current = JSON.parse(await readFile(this.configFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await this.atomicWrite(path.join(this.backupDir, `config-${stamp}-${randomUUID()}.json`), current);
    const files = (await readdir(this.backupDir)).filter((name) => name.endsWith(".json")).sort().reverse();
    await Promise.all(files.slice(30).map((name) => unlink(path.join(this.backupDir, name))));
  }
}
