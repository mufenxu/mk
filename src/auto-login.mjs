import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { checkSession } from "./client.mjs";
import { ConfigError, RemoteError } from "./errors.mjs";

const SESSION_COOKIE = "monkeycode_ai_session";
const USER_AGENT = "monkeycode-daily-sender/1.0";
const RENEW_BEFORE_MS = 24 * 60 * 60_000;
const FAILURE_DELAYS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function capPrng(seed, length) {
  let state = fnv1a(seed);
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    result += state.toString(16).padStart(8, "0");
  }
  return result.slice(0, length);
}

function validChallenge(token, challenge) {
  return typeof token === "string"
    && /^[0-9a-f]{1,128}$/i.test(token)
    && Number.isInteger(challenge?.c) && challenge.c >= 1 && challenge.c <= 100
    && Number.isInteger(challenge?.s) && challenge.s >= 1 && challenge.s <= 128
    && Number.isInteger(challenge?.d) && challenge.d >= 1 && challenge.d <= 4;
}

export async function solveCapChallenge(token, challenge, options = {}) {
  if (!validChallenge(token, challenge)) throw new RemoteError("MonkeyCode returned unsupported CAPTCHA parameters");
  const signal = options.signal;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const solutions = [];
  let attemptsSinceYield = 0;

  for (let index = 1; index <= challenge.c; index += 1) {
    const seed = `${token}${index}`;
    const target = capPrng(`${seed}d`, challenge.d);
    const saltHash = createHash("sha256").update(capPrng(seed, challenge.s));
    let nonce = 0;
    while (!saltHash.copy().update(String(nonce)).digest("hex").startsWith(target)) {
      nonce += 1;
      attemptsSinceYield += 1;
      if (attemptsSinceYield >= 2_048) {
        if (signal?.aborted) throw new RemoteError("MonkeyCode CAPTCHA solving was cancelled");
        if (Date.now() >= deadline) throw new RemoteError("MonkeyCode CAPTCHA solving timed out");
        attemptsSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    solutions.push(nonce);
  }
  return solutions;
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const detail = error?.name === "AbortError" ? "request timed out" : error.message;
    throw new RemoteError(`MonkeyCode login request failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new RemoteError(`MonkeyCode returned invalid JSON for ${new URL(url).pathname}`, response.status);
  }
  if (!response.ok) {
    throw new RemoteError(`MonkeyCode returned HTTP ${response.status} for ${new URL(url).pathname}`, response.status);
  }
  return { response, body };
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

export function extractSessionCookie(headers, now = Date.now()) {
  for (const header of responseCookies(headers)) {
    const parts = header.split(";").map((part) => part.trim());
    const [name, ...valueParts] = parts[0].split("=");
    if (name !== SESSION_COOKIE) continue;
    const session = valueParts.join("=");
    if (!session) throw new RemoteError("MonkeyCode returned an empty session cookie");
    let expiresAt = null;
    for (const attribute of parts.slice(1)) {
      const separator = attribute.indexOf("=");
      const key = (separator >= 0 ? attribute.slice(0, separator) : attribute).trim().toLowerCase();
      const value = separator >= 0 ? attribute.slice(separator + 1).trim() : "";
      if (key === "max-age" && /^\d+$/.test(value)) expiresAt = new Date(now + Number(value) * 1_000).toISOString();
      if (key === "expires" && !expiresAt) {
        const timestamp = new Date(value).getTime();
        if (Number.isFinite(timestamp)) expiresAt = new Date(timestamp).toISOString();
      }
    }
    return { session, expiresAt };
  }
  throw new RemoteError("MonkeyCode login did not return a session cookie");
}

export async function loginWithPassword(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = options.baseUrl instanceof URL ? options.baseUrl : new URL(options.baseUrl);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  const captchaBase = new URL("/api/v1/public/captcha/", baseUrl);
  const challengeResult = await requestJson(fetchImpl, new URL("challenge", captchaBase), {
    method: "POST",
    headers,
  }, timeoutMs);
  const solutions = await solveCapChallenge(
    challengeResult.body.token,
    challengeResult.body.challenge,
    { timeoutMs: 90_000 },
  );
  const redeemResult = await requestJson(fetchImpl, new URL("redeem", captchaBase), {
    method: "POST",
    headers,
    body: JSON.stringify({ token: challengeResult.body.token, solutions }),
  }, timeoutMs);
  if (!redeemResult.body.success || !redeemResult.body.token) {
    throw new RemoteError("MonkeyCode rejected the CAPTCHA solution");
  }

  const loginResult = await requestJson(fetchImpl, new URL("/api/v1/users/password-login", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: options.email,
      password: options.password,
      captcha_token: redeemResult.body.token,
    }),
  }, timeoutMs);
  if (loginResult.body?.code !== 0) throw new RemoteError("MonkeyCode rejected the saved login credentials", 422);
  return extractSessionCookie(loginResult.response.headers);
}

export class AutoLoginService {
  constructor(store, notifications, options = {}) {
    this.store = store;
    this.notifications = notifications;
    this.login = options.login ?? loginWithPassword;
    this.checkSession = options.checkSession ?? checkSession;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS;
    this.inflight = new Map();
    this.timer = null;
  }

  needsRenewal(account, now = new Date()) {
    if (!account?.autoLoginEnabled || !account.loginConfigured) return false;
    const nextAttemptAt = new Date(account.autoLoginNextAttemptAt ?? 0).getTime();
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) return false;
    if (!account.sessionConfigured || account.lastValidationStatus === "invalid") return true;
    const expiresAt = new Date(account.sessionExpiresAt ?? 0).getTime();
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - now.getTime() <= this.renewBeforeMs;
  }

  async renewIfNeeded(account, options = {}) {
    if (!this.needsRenewal(account, options.now ?? new Date())) return { renewed: false, account };
    return { renewed: true, account: await this.renewAccount(account.id, options) };
  }

  async renewAccount(id, options = {}) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const promise = this.#renewAccount(id, options).finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  async #renewAccount(id, options) {
    const account = this.store.getAccount(id, { withLogin: true });
    if (!account) throw new ConfigError("Account not found");
    if (!account.login?.email || !account.login?.password) throw new ConfigError("Automatic login credentials are not configured");
    const now = options.now ?? new Date();
    let updated;
    try {
      const result = await this.login({
        baseUrl: new URL(account.baseUrl),
        email: account.login.email,
        password: account.login.password,
      });
      const user = await this.checkSession({
        baseUrl: new URL(account.baseUrl),
        session: result.session,
        timeoutMs: 30_000,
      });
      if (account.userId && String(user.id) !== account.userId) {
        throw new ConfigError("Automatic login returned a different MonkeyCode account");
      }
      updated = await this.store.recordAutoLoginSuccess(id, { ...result, user, now });
    } catch (error) {
      const updated = await this.store.recordAutoLoginFailure(id, error.message, now, FAILURE_DELAYS_MS);
      const detail = `Automatic login failed: ${error.message}`;
      await this.store.appendLog({
        type: "auto-login",
        accountId: id,
        accountName: updated.name,
        status: "failed",
        trigger: options.trigger ?? "schedule",
        detail,
      });
      await this.notifications.notify("auth-expired", {
        accountName: updated.name,
        detail,
        at: now.toISOString(),
      });
      throw error;
    }
    await this.store.appendLog({
      type: "auto-login",
      accountId: id,
      accountName: updated.name,
      status: "valid",
      trigger: options.trigger ?? "schedule",
      detail: "MonkeyCode session was renewed automatically",
    });
    return updated;
  }

  async tick(now = new Date()) {
    for (const account of this.store.getPublicConfig().accounts ?? []) {
      try {
        await this.renewIfNeeded(account, { now, trigger: "schedule" });
      } catch {
        // Failure state, backoff and notification are recorded by renewAccount().
      }
    }
  }

  start() {
    if (this.timer) return;
    this.tick().catch((error) => console.error(`Automatic login check failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error(`Automatic login check failed: ${error.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
