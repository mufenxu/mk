import { createHash, timingSafeEqual } from "node:crypto";

import { checkSession } from "./client.mjs";
import { BridgeError, ConfigError } from "./errors.mjs";
import { createToken } from "./security.mjs";

const COOKIE = /^[A-Za-z0-9._~-]+$/;
const DEVICE_ID = /^[A-Za-z0-9._~-]{8,128}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PAIR_CODE_TTL_MS = 5 * 60_000;
const PAIR_ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_PAIR_ATTEMPTS = 10;
const MIN_SYNC_INTERVAL_MS = 1_000;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function cleanExtensionOrigin(origin) {
  if (typeof origin !== "string" || !EXTENSION_ORIGIN.test(origin)) {
    throw new BridgeError("Chrome extension origin is required", 403, "extension-origin-required");
  }
  return origin;
}

function cleanDeviceId(value) {
  const deviceId = typeof value === "string" ? value.trim() : "";
  if (!DEVICE_ID.test(deviceId)) throw new BridgeError("Device identifier is invalid", 400, "invalid-device-id");
  return deviceId;
}

function cleanDeviceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw new BridgeError("Device name is invalid", 400, "invalid-device-name");
  return name;
}

function cleanExpiry(value, now) {
  if (value === null || value === undefined || value === "") return null;
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new BridgeError("Cookie expiration is invalid", 400, "invalid-cookie-expiration");
  }
  if (expiresAt.getTime() <= now) {
    throw new BridgeError("Cookie has already expired", 422, "cookie-expired");
  }
  if (expiresAt.getTime() > now + 400 * 86_400_000) {
    throw new BridgeError("Cookie expiration is too far in the future", 400, "invalid-cookie-expiration");
  }
  return expiresAt.toISOString();
}

function bearerToken(value) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value ?? "");
  if (!match) throw new BridgeError("Browser bridge authentication is required", 401, "bridge-authentication-required");
  return match[1];
}

export function isExtensionOrigin(origin) {
  return typeof origin === "string" && EXTENSION_ORIGIN.test(origin);
}

export class BrowserBridgeService {
  constructor(store, options = {}) {
    this.store = store;
    this.checkSession = options.checkSession ?? checkSession;
    this.now = options.now ?? (() => Date.now());
    this.pairCodeTtlMs = options.pairCodeTtlMs ?? PAIR_CODE_TTL_MS;
    this.pairCodes = new Map();
    this.pairAttempts = new Map();
    this.lastSync = new Map();
  }

  generatePairCode(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new ConfigError("Account not found");
    for (const [key, pending] of this.pairCodes) {
      if (pending.accountId === accountId || new Date(pending.expiresAt).getTime() <= this.now()) {
        this.pairCodes.delete(key);
      }
    }
    const code = createToken(9);
    const expiresAt = new Date(this.now() + this.pairCodeTtlMs).toISOString();
    this.pairCodes.set(sha256(code), { accountId, expiresAt });
    return { code, expiresAt, account: { id: account.id, name: account.name, baseUrl: account.baseUrl } };
  }

  recordPairAttempt(key) {
    const now = this.now();
    const recent = (this.pairAttempts.get(key) ?? []).filter((time) => now - time < PAIR_ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_PAIR_ATTEMPTS) {
      throw new BridgeError("Too many pairing attempts", 429, "too-many-pairing-attempts");
    }
    recent.push(now);
    this.pairAttempts.set(key, recent);
  }

  async pair(input, context) {
    const origin = cleanExtensionOrigin(context.origin);
    const attemptKey = `${origin}|${context.address ?? "unknown"}`;
    this.recordPairAttempt(attemptKey);
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const key = sha256(code);
    const pending = this.pairCodes.get(key);
    if (!pending || new Date(pending.expiresAt).getTime() <= this.now()) {
      if (pending) this.pairCodes.delete(key);
      throw new BridgeError("Pairing code is invalid or expired", 401, "invalid-pairing-code");
    }
    this.pairCodes.delete(key);

    const account = this.store.getAccount(pending.accountId);
    if (!account) throw new BridgeError("Pairing account no longer exists", 410, "pairing-account-missing");
    const token = createToken(32);
    const bridge = await this.store.createBrowserBridge({
      accountId: account.id,
      deviceId: cleanDeviceId(input.deviceId),
      deviceName: cleanDeviceName(input.deviceName),
      extensionOrigin: origin,
      tokenHash: sha256(token),
    });
    this.pairAttempts.delete(attemptKey);
    return {
      token,
      bridge,
      account: { id: account.id, name: account.name, baseUrl: account.baseUrl, userId: account.userId },
    };
  }

  authenticate(authorization, origin) {
    const extensionOrigin = cleanExtensionOrigin(origin);
    const tokenHash = sha256(bearerToken(authorization));
    const bridge = this.store.findBrowserBridge((entry) => (
      !entry.revokedAt
      && entry.extensionOrigin === extensionOrigin
      && equalHex(entry.tokenHash, tokenHash)
    ));
    if (!bridge) throw new BridgeError("Browser bridge token is invalid", 401, "invalid-bridge-token");
    return bridge;
  }

  async sync(input, context) {
    const bridge = this.authenticate(context.authorization, context.origin);
    const now = this.now();
    const lastSync = this.lastSync.get(bridge.id) ?? 0;
    if (now - lastSync < MIN_SYNC_INTERVAL_MS) {
      throw new BridgeError("Cookie synchronization is too frequent", 429, "sync-rate-limited");
    }
    this.lastSync.set(bridge.id, now);

    const session = typeof input.session === "string" ? input.session.trim() : "";
    if (!COOKIE.test(session)) {
      await this.store.recordBrowserBridgeStatus(bridge.id, "invalid", "Cookie value is invalid");
      throw new BridgeError("Cookie value is invalid", 400, "invalid-cookie");
    }
    const expiresAt = cleanExpiry(input.expiresAt, now);
    const account = this.store.getAccount(bridge.accountId, { withSession: true });
    if (!account) throw new BridgeError("Paired account no longer exists", 410, "paired-account-missing");

    let user;
    try {
      user = await this.checkSession({
        baseUrl: new URL(account.baseUrl),
        session,
        timeoutMs: 30_000,
      });
    } catch (error) {
      await this.store.recordBrowserBridgeStatus(bridge.id, "invalid", "Cookie validation failed");
      throw new BridgeError(`Cookie validation failed: ${error.message}`, 422, "cookie-validation-failed");
    }

    const userId = user?.id ? String(user.id) : "";
    if (!userId) {
      await this.store.recordBrowserBridgeStatus(bridge.id, "invalid", "MonkeyCode user identity is missing");
      throw new BridgeError("MonkeyCode user identity is missing", 422, "user-identity-missing");
    }
    if (account.userId && account.userId !== userId) {
      await this.store.recordBrowserBridgeStatus(bridge.id, "account-mismatch", "Signed-in MonkeyCode account does not match");
      throw new BridgeError("Signed-in MonkeyCode account does not match this pairing", 409, "account-mismatch");
    }

    const updated = await this.store.updateAccountSessionFromBridge(account.id, {
      session,
      expiresAt,
      bridgeId: bridge.id,
      user,
    });
    await this.store.appendLog({
      type: "browser-sync",
      accountId: account.id,
      accountName: account.name,
      status: "valid",
      detail: "Chrome Cookie synchronized and validated",
    });
    return { account: updated, bridge: this.store.getPublicBrowserBridge(bridge.id) };
  }

  async status(context) {
    const bridge = this.authenticate(context.authorization, context.origin);
    await this.store.recordBrowserBridgeStatus(bridge.id, bridge.lastStatus ?? "connected", null, { seenOnly: true });
    const account = this.store.getAccount(bridge.accountId);
    return { bridge: this.store.getPublicBrowserBridge(bridge.id), account };
  }

  async disconnect(context) {
    const bridge = this.authenticate(context.authorization, context.origin);
    await this.store.revokeBrowserBridge(bridge.id);
    this.lastSync.delete(bridge.id);
    return { ok: true };
  }
}
