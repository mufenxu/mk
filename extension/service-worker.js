const COOKIE_NAME = "monkeycode_ai_session";
const CHECK_ALARM = "monkeycode-cookie-check";
const CHECK_INTERVAL_MINUTES = 360;
const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;
const STORAGE_KEYS = ["connection", "deviceId", "lastExpiryNotification"];

function normalizePanelUrl(value) {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("VPS 面板必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("面板地址格式不正确");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

async function storageGet() {
  return chrome.storage.local.get(STORAGE_KEYS);
}

async function getDeviceId() {
  const current = await chrome.storage.local.get("deviceId");
  if (current.deviceId) return current.deviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

async function setBadge(status) {
  const settings = {
    valid: { text: "OK", color: "#176345" },
    warning: { text: "!", color: "#996515" },
    error: { text: "X", color: "#9c252b" },
    idle: { text: "", color: "#687681" },
  }[status] ?? { text: "", color: "#687681" };
  await chrome.action.setBadgeBackgroundColor({ color: settings.color });
  await chrome.action.setBadgeText({ text: settings.text });
}

async function bridgeRequest(connection, pathname, options = {}) {
  const response = await fetch(`${connection.panelUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `VPS 返回 HTTP ${response.status}`);
    error.code = payload.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function activeCookie(connection) {
  const baseUrl = new URL(connection.account.baseUrl);
  return chrome.cookies.get({ url: `${baseUrl.origin}/`, name: COOKIE_NAME });
}

async function showExpiryNotification(connection, expiresAt) {
  if (!expiresAt) return;
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry - Date.now() > EXPIRY_WARNING_MS) return;
  const key = `${connection.account.id}:${expiresAt}`;
  const stored = await chrome.storage.local.get("lastExpiryNotification");
  if (stored.lastExpiryNotification === key) return;
  await chrome.storage.local.set({ lastExpiryNotification: key });
  await chrome.notifications.create(`expiry:${connection.account.id}`, {
    type: "basic",
    iconUrl: "icons/icon.png",
    title: expiry <= Date.now() ? "MonkeyCode 登录已失效" : "MonkeyCode 登录即将到期",
    message: `${connection.account.name}：请重新登录后自动同步。`,
    priority: 1,
  });
}

async function showMissingCookieNotification(connection) {
  const key = `${connection.account.id}:missing`;
  const stored = await chrome.storage.local.get("lastExpiryNotification");
  if (stored.lastExpiryNotification === key) return;
  await chrome.storage.local.set({ lastExpiryNotification: key });
  await chrome.notifications.create(`expiry:${connection.account.id}`, {
    type: "basic",
    iconUrl: "icons/icon.png",
    title: "MonkeyCode 登录已失效",
    message: `${connection.account.name}：请重新登录后自动同步。`,
    priority: 1,
  });
}

async function syncCookie(reason = "manual") {
  const stored = await storageGet();
  const connection = stored.connection;
  if (!connection?.token) {
    await setBadge("idle");
    return { connected: false, reason: "not-paired" };
  }
  const cookie = await activeCookie(connection);
  if (!cookie?.value) {
    await setBadge("warning");
    await showMissingCookieNotification(connection);
    return { connected: true, synchronized: false, reason: "cookie-missing" };
  }
  const expiresAt = cookie.expirationDate ? new Date(cookie.expirationDate * 1000).toISOString() : null;
  try {
    const result = await bridgeRequest(connection, "/api/browser-bridge/sync", {
      method: "POST",
      token: connection.token,
      body: { session: cookie.value, expiresAt, reason },
    });
    const nextConnection = {
      ...connection,
      account: {
        ...connection.account,
        ...result.account,
        bridges: undefined,
      },
      lastSyncedAt: result.account.lastSyncedAt,
      sessionExpiresAt: result.account.sessionExpiresAt,
      lastStatus: "valid",
      lastError: null,
    };
    await chrome.storage.local.set({ connection: nextConnection });
    await setBadge("valid");
    await showExpiryNotification(nextConnection, result.account.sessionExpiresAt);
    return { connected: true, synchronized: true, connection: nextConnection };
  } catch (error) {
    const lastStatus = error.code === "account-mismatch" ? "account-mismatch" : "error";
    await chrome.storage.local.set({ connection: { ...connection, lastStatus, lastError: error.message } });
    await setBadge("error");
    throw error;
  }
}

async function pair(input) {
  const panelUrl = normalizePanelUrl(input.panelUrl);
  const deviceId = await getDeviceId();
  const temporary = { panelUrl };
  const result = await bridgeRequest(temporary, "/api/browser-bridge/pair", {
    method: "POST",
    body: {
      code: String(input.code ?? "").trim(),
      deviceId,
      deviceName: String(input.deviceName ?? "").trim(),
    },
  });
  const connection = {
    panelUrl,
    token: result.token,
    bridge: result.bridge,
    account: result.account,
    lastStatus: "connected",
    lastError: null,
  };
  await chrome.storage.local.set({ connection, lastExpiryNotification: null });
  await setBadge("warning");
  let sync;
  try {
    sync = await syncCookie("pairing");
  } catch (error) {
    sync = { connected: true, synchronized: false, reason: error.code || "sync-failed", error: error.message };
  }
  return { ...result, sync };
}

async function connectionState() {
  const stored = await storageGet();
  const connection = stored.connection;
  if (!connection?.token) return { connected: false };
  try {
    const remote = await bridgeRequest(connection, "/api/browser-bridge/status", { token: connection.token });
    const next = { ...connection, bridge: remote.bridge, account: remote.account, lastError: null };
    await chrome.storage.local.set({ connection: next });
    return { connected: true, connection: next };
  } catch (error) {
    return { connected: true, connection: { ...connection, lastError: error.message } };
  }
}

async function disconnect() {
  const stored = await storageGet();
  const connection = stored.connection;
  if (connection?.token) {
    try {
      await bridgeRequest(connection, "/api/browser-bridge/disconnect", { method: "POST", token: connection.token });
    } catch {
      // Local credentials are removed even if the VPS is temporarily unavailable.
    }
  }
  await chrome.storage.local.remove(["connection", "lastExpiryNotification"]);
  await setBadge("idle");
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message?.type === "pair"
    ? pair(message)
    : message?.type === "sync"
      ? syncCookie("manual")
      : message?.type === "disconnect"
        ? disconnect()
        : message?.type === "state"
          ? connectionState()
          : Promise.reject(new Error("未知操作"));
  action.then((result) => sendResponse({ ok: true, result }), (error) => {
    sendResponse({ ok: false, error: error.message, code: error.code });
  });
  return true;
});

chrome.cookies.onChanged.addListener(async ({ removed, cookie }) => {
  if (cookie.name !== COOKIE_NAME) return;
  const stored = await storageGet();
  const connection = stored.connection;
  if (!connection?.account?.baseUrl) return;
  const expectedHost = new URL(connection.account.baseUrl).hostname;
  if (cookie.domain.replace(/^\./, "") !== expectedHost) return;
  if (removed) {
    await setBadge("warning");
    return;
  }
  await syncCookie("cookie-changed").catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) syncCookie("periodic-check").catch(() => {});
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith("expiry:")) return;
  const stored = await storageGet();
  const baseUrl = stored.connection?.account?.baseUrl ?? "https://monkeycode-ai.com";
  await chrome.tabs.create({ url: `${new URL(baseUrl).origin}/login` });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function initialize() {
  await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  await syncCookie("browser-startup").catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
initialize().catch(() => {});
