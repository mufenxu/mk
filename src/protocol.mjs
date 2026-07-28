import { createHash } from "node:crypto";

export const COOKIE_NAME = "monkeycode_ai_session";

export function cookieHeader(session) {
  return `${COOKIE_NAME}=${session}`;
}

export function makeStreamUrl(baseUrl, taskId) {
  const url = new URL("/api/v1/users/tasks/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("id", taskId);
  url.searchParams.set("mode", "new");
  return url;
}

export function encodeUserInput(prompt) {
  const inner = {
    content: Buffer.from(prompt, "utf8").toString("base64"),
    attachments: [],
  };
  return JSON.stringify({
    type: "user-input",
    data: Buffer.from(JSON.stringify(inner), "utf8").toString("base64"),
  });
}

export function promptHash(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function dayKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function timestampToDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && /[-T:]/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  let numeric;
  try {
    numeric = BigInt(String(value));
  } catch {
    return null;
  }

  const digits = numeric < 0n ? String(-numeric).length : String(numeric).length;
  if (digits >= 19) numeric /= 1_000_000n;
  else if (digits >= 16) numeric /= 1_000n;
  else if (digits <= 10) numeric *= 1_000n;

  const milliseconds = Number(numeric);
  if (!Number.isFinite(milliseconds)) return null;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function promptPreview(prompt, length = 500) {
  return Array.from(prompt).slice(0, length).join("");
}

function itemDate(item) {
  return timestampToDate(
    item.timestamp ?? item.created_at ?? item.createdAt ?? item.time ?? item.create_time,
  );
}

export function isDuplicateHistory(items, prompt, now, timeZone, options = {}) {
  const today = dayKey(now, timeZone);
  const preview = promptPreview(prompt);
  const since = options.since ? new Date(options.since).getTime() : null;

  return items.some((item) => {
    if (!item || typeof item !== "object" || typeof item.content !== "string") return false;
    const date = itemDate(item);
    if (!date || dayKey(date, timeZone) !== today) return false;
    if (Number.isFinite(since) && date.getTime() < since - 120_000) return false;
    return item.content === prompt || (item.truncated === true && item.content === preview);
  });
}

export function extractHistoryItems(body) {
  const candidates = [
    body,
    body?.data,
    body?.data?.items,
    body?.data?.list,
    body?.data?.user_inputs,
    body?.data?.userInputs,
    body?.items,
    body?.list,
    body?.user_inputs,
    body?.userInputs,
  ];
  const items = candidates.find(Array.isArray);
  if (!items) {
    throw new Error("History response does not contain an item array");
  }
  return items;
}
