import { readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors.mjs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parseInteger(env, name, fallback, min, max) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseBoolean(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function validateBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("MONKEYCODE_BASE_URL must be a valid URL");
  }

  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new ConfigError("MONKEYCODE_BASE_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("MONKEYCODE_BASE_URL must not include credentials, query, or hash");
  }

  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function validateTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ConfigError("MONKEYCODE_TIMEZONE is not a valid IANA timezone");
  }
  return timeZone;
}

async function loadPrompt(env) {
  const inlinePrompt = env.MONKEYCODE_PROMPT;
  const promptFile = env.MONKEYCODE_PROMPT_FILE?.trim();

  if (inlinePrompt !== undefined && promptFile) {
    throw new ConfigError("Set only one of MONKEYCODE_PROMPT and MONKEYCODE_PROMPT_FILE");
  }

  let prompt;
  if (promptFile) {
    try {
      prompt = await readFile(promptFile, "utf8");
    } catch (error) {
      throw new ConfigError(`Cannot read MONKEYCODE_PROMPT_FILE: ${error.message}`);
    }
  } else if (inlinePrompt !== undefined) {
    prompt = inlinePrompt;
  } else {
    throw new ConfigError("MONKEYCODE_PROMPT or MONKEYCODE_PROMPT_FILE is required");
  }

  prompt = prompt.replace(/(?:\r?\n)+$/, "");
  if (!prompt.trim()) {
    throw new ConfigError("The configured prompt is empty");
  }
  if (Buffer.byteLength(prompt, "utf8") > 1024 * 1024) {
    throw new ConfigError("The configured prompt exceeds 1 MiB");
  }
  return prompt;
}

export async function loadConfig(env = process.env) {
  const taskId = required(env, "MONKEYCODE_TASK_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw new ConfigError("MONKEYCODE_TASK_ID must be a UUID");
  }

  const session = required(env, "MONKEYCODE_SESSION");
  if (!/^[A-Za-z0-9._~-]+$/.test(session)) {
    throw new ConfigError("MONKEYCODE_SESSION contains invalid cookie characters");
  }

  return {
    baseUrl: validateBaseUrl(env.MONKEYCODE_BASE_URL?.trim() || "https://monkeycode-ai.com"),
    taskId,
    session,
    prompt: await loadPrompt(env),
    timeZone: validateTimezone(env.MONKEYCODE_TIMEZONE?.trim() || "Asia/Shanghai"),
    timeoutMs: parseInteger(env, "MONKEYCODE_TIMEOUT_MS", 30_000, 1_000, 300_000),
    historyLimit: parseInteger(env, "MONKEYCODE_HISTORY_LIMIT", 20, 1, 100),
    stateFile: path.resolve(env.MONKEYCODE_STATE_FILE?.trim() || ".monkeycode-daily-state.json"),
    dryRun: parseBoolean(env, "MONKEYCODE_DRY_RUN", true),
  };
}
