import nodemailer from "nodemailer";

import { RemoteError } from "./errors.mjs";

function messageFor(event, context) {
  const labels = {
    sent: "发送成功",
    accepted: "消息已接收",
    completed: "远端任务已完成",
    "completion-timeout": "远端完成确认超时",
    "auto-paused": "任务已自动暂停",
    failed: "发送失败",
    "auth-expired": "登录已失效",
    "session-warning": "登录凭证即将到期",
    "auto-login-failed": "自动续期失败",
    "auto-login-recovered": "自动续期已恢复",
    duplicate: "检测到重复并跳过",
    "quota-low": "每日额度不足",
    "remote-task-error": "远端任务异常",
    "environment-hibernated": "任务环境已休眠",
    "remote-task-missing": "远端任务未找到",
    "sync-failed": "远端同步失败",
    "node-pool-unavailable": "节点池控制器不可用",
    "node-offline": "部署节点离线",
    "deployment-failed": "项目部署失败",
    "deployment-backlog": "部署队列积压",
    test: "通知测试成功",
  };
  const title = `MonkeyCode · ${labels[event] ?? event}`;
  const subjectLabel = context.accountName ? "账号" : "任务";
  const subjectName = context.accountName ?? context.taskName ?? "通知测试";
  const lines = [
    title,
    `${subjectLabel}：${subjectName}`,
    `时间：${context.at ?? new Date().toISOString()}`,
  ];
  if (context.detail) lines.push(`详情：${context.detail}`);
  return { title, body: lines.join("\n") };
}

async function postJson(url, body, extraHeaders = {}, timeoutMs = 15_000) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RemoteError(`Notification request failed: ${error.message}`);
  }
  if (!response.ok) throw new RemoteError(`Notification endpoint returned HTTP ${response.status}`, response.status);
}

export async function sendNotification(channel, event, context) {
  const message = messageFor(event, context);

  if (channel.type === "generic") {
    return postJson(channel.secret.webhookUrl, { event, ...context, title: message.title, message: message.body });
  }
  if (channel.type === "wecom") {
    return postJson(channel.secret.webhookUrl, { msgtype: "text", text: { content: message.body } });
  }
  if (channel.type === "dingtalk") {
    return postJson(channel.secret.webhookUrl, { msgtype: "text", text: { content: message.body } });
  }
  if (channel.type === "pxyb") {
    return postJson(channel.settings.endpointUrl, {
      msg_type: "text",
      touser: channel.settings.touser,
      data: { content: message.body },
    }, { "X-API-KEY": channel.secret.apiKey });
  }
  if (channel.type === "telegram") {
    const endpoint = `https://api.telegram.org/bot${channel.secret.botToken}/sendMessage`;
    return postJson(endpoint, { chat_id: channel.settings.chatId, text: message.body });
  }
  if (channel.type === "bark") {
    const endpoint = new URL("push", `${channel.settings.serverUrl.replace(/\/$/, "")}/`);
    return postJson(endpoint, {
      device_key: channel.secret.deviceKey,
      title: message.title,
      body: message.body,
      group: "MonkeyCode",
    });
  }
  if (channel.type === "email") {
    const transport = nodemailer.createTransport({
      host: channel.settings.host,
      port: channel.settings.port,
      secure: channel.settings.secure,
      auth: { user: channel.settings.user, pass: channel.secret.password },
      connectionTimeout: 15_000,
      socketTimeout: 20_000,
    });
    await transport.sendMail({
      from: channel.settings.from,
      to: channel.settings.to,
      subject: message.title,
      text: message.body,
    });
    return;
  }
  throw new RemoteError(`Unsupported notification type: ${channel.type}`);
}

export class NotificationService {
  constructor(store) {
    this.store = store;
  }

  async notify(event, context) {
    const channels = this.store.listNotificationsWithSecrets()
      .filter((channel) => channel.enabled && (
        channel.events.includes(event)
        || (event === "completed" && channel.events.includes("sent"))
        || (["completion-timeout", "auto-paused"].includes(event) && channel.events.includes("failed"))
      ));
    const results = await Promise.allSettled(channels.map((channel) => sendNotification(channel, event, context)));
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].status === "rejected") {
        await this.store.appendLog({
          type: "notification",
          notificationId: channels[index].id,
          notificationName: channels[index].name,
          status: "failed",
          detail: results[index].reason?.message ?? "Notification failed",
        });
      }
    }
    return results;
  }

  async test(id) {
    const channel = this.store.getNotification(id, { withSecret: true });
    if (!channel) throw new RemoteError("Notification channel not found", 404);
    await sendNotification(channel, "test", { taskName: "控制台通知测试" });
  }
}
