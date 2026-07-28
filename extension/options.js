const pairSection = document.querySelector("#pair-section");
const statusSection = document.querySelector("#status-section");
const message = document.querySelector("#message");

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response?.ok) return reject(new Error(response?.error || "扩展操作失败"));
      resolve(response.result);
    });
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}

function showMessage(text, error = false) {
  message.textContent = text;
  message.className = error ? "error" : "success";
}

function render(state) {
  const connection = state?.connection;
  pairSection.hidden = Boolean(state?.connected);
  statusSection.hidden = !state?.connected;
  document.querySelector("#connection-summary").textContent = state?.connected ? "已连接" : "未连接";
  if (!state?.connected) return;
  document.querySelector("#account-name").textContent = connection.account?.name || "-";
  document.querySelector("#user-name").textContent = connection.account?.userName || connection.account?.userId || "待同步";
  document.querySelector("#remote-panel").textContent = connection.panelUrl;
  document.querySelector("#last-sync").textContent = formatDate(connection.account?.lastSyncedAt || connection.lastSyncedAt);
  document.querySelector("#cookie-expiry").textContent = formatDate(connection.account?.sessionExpiresAt || connection.sessionExpiresAt);
  document.querySelector("#bridge-status").textContent = connection.lastError || connection.bridge?.lastStatus || connection.lastStatus || "已连接";
}

async function requestPanelPermission(panelUrl) {
  const url = new URL(panelUrl);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("VPS 面板必须使用 HTTPS");
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) throw new Error("未授予访问 VPS 面板的权限");
}

document.querySelector("#pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const data = new FormData(event.currentTarget);
  const panelUrl = String(data.get("panelUrl") || "").trim();
  try {
    await requestPanelPermission(panelUrl);
    const paired = await send("pair", {
      panelUrl,
      code: data.get("code"),
      deviceName: data.get("deviceName"),
    });
    render(await send("state"));
    showMessage(
      paired.sync?.synchronized ? "账号已连接，Cookie 已完成验证和同步" : paired.sync?.error || "账号已连接，等待 MonkeyCode 登录 Cookie",
      !paired.sync?.synchronized,
    );
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#sync-button").addEventListener("click", async () => {
  try {
    await send("sync");
    render(await send("state"));
    showMessage("Cookie 已同步");
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#disconnect-button").addEventListener("click", async () => {
  try {
    await send("disconnect");
    render({ connected: false });
    showMessage("连接已断开");
  } catch (error) {
    showMessage(error.message, true);
  }
});

async function boot() {
  const platform = await chrome.runtime.getPlatformInfo();
  document.querySelector("#device-name").value = `${platform.os} / Chrome`;
  render(await send("state"));
}

boot().catch((error) => showMessage(error.message, true));
