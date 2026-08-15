import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { OidcAuthError } from "./errors.mjs";
import { createToken } from "./security.mjs";

const DISCOVERY_TTL_MS = 60 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
const ROLE_LEVEL = new Map([
  ["viewer", 0],
  ["operator", 1],
  ["super_admin", 2],
]);

function base64urlSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function validateEndpoint(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OidcAuthError(`OIDC discovery returned an invalid ${name}`, 502, "oidc-discovery-invalid");
  }
  if (url.protocol !== "https:") {
    throw new OidcAuthError(`OIDC discovery returned an insecure ${name}`, 502, "oidc-discovery-invalid");
  }
  return url;
}

function highestRole(value) {
  const roles = Array.isArray(value) ? value : [value];
  return roles
    .filter((role) => ROLE_LEVEL.has(role))
    .sort((left, right) => ROLE_LEVEL.get(right) - ROLE_LEVEL.get(left))[0] ?? null;
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class OidcAuthService {
  constructor(options) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.sessionSecret = options.sessionSecret;
    this.requiredRole = options.requiredRole;
    this.pendingStates = new Map();
    this.discoveryCache = null;
    this.jwks = null;
    this.jwksUri = null;
  }

  stateCookie(state) {
    return createHmac("sha256", this.sessionSecret).update(state, "utf8").digest("base64url");
  }

  async discovery() {
    if (this.discoveryCache?.expiresAt > Date.now()) return this.discoveryCache.value;
    const discoveryUrl = new URL("/.well-known/openid-configuration", `${this.issuer}/`);
    let response;
    try {
      response = await fetch(discoveryUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new OidcAuthError("Cannot reach the MY OIDC discovery endpoint", 502, "oidc-discovery-unavailable");
    }
    let document;
    if (response.ok) {
      try {
        document = await response.json();
      } catch {
        throw new OidcAuthError("MY OIDC discovery response is invalid", 502, "oidc-discovery-invalid");
      }
    } else {
      const contractUrl = new URL("/docs/external-auth.json", `${this.issuer}/`);
      let contractResponse;
      try {
        contractResponse = await fetch(contractUrl, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new OidcAuthError("MY OIDC discovery request failed", 502, "oidc-discovery-unavailable");
      }
      if (!contractResponse.ok) {
        throw new OidcAuthError("MY OIDC discovery request failed", 502, "oidc-discovery-unavailable");
      }
      try {
        const contract = await contractResponse.json();
        document = {
          issuer: contract.issuer,
          authorization_endpoint: contract.endpoints?.authorization,
          token_endpoint: contract.endpoints?.token,
          jwks_uri: contract.endpoints?.jwks,
        };
      } catch {
        throw new OidcAuthError("MY OIDC contract response is invalid", 502, "oidc-discovery-invalid");
      }
    }
    if (document.issuer !== this.issuer) {
      throw new OidcAuthError("MY OIDC issuer does not match configuration", 502, "oidc-discovery-invalid");
    }
    const value = {
      issuer: document.issuer,
      authorizationEndpoint: validateEndpoint(document.authorization_endpoint, "authorization endpoint"),
      tokenEndpoint: validateEndpoint(document.token_endpoint, "token endpoint"),
      jwksUri: validateEndpoint(document.jwks_uri, "JWKS endpoint"),
    };
    this.discoveryCache = { value, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return value;
  }

  async start() {
    const now = Date.now();
    for (const [state, pending] of this.pendingStates) {
      if (pending.expiresAt <= now) this.pendingStates.delete(state);
    }
    const discovery = await this.discovery();
    const state = createToken(24);
    const nonce = createToken(24);
    const codeVerifier = createToken(48);
    this.pendingStates.set(state, {
      nonce,
      codeVerifier,
      expiresAt: now + STATE_TTL_MS,
    });
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "openid profile roles",
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: base64urlSha256(codeVerifier),
    }).toString();
    return { authorizationUrl, stateCookie: this.stateCookie(state) };
  }

  async callback(searchParams, stateCookie) {
    const state = searchParams.get("state");
    const pending = state ? this.pendingStates.get(state) : null;
    if (state) this.pendingStates.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new OidcAuthError("OIDC login state is missing or expired", 400, "oidc-state-invalid");
    }
    if (!safeEqual(stateCookie, this.stateCookie(state))) {
      throw new OidcAuthError("OIDC login was not started in this browser", 400, "oidc-state-invalid");
    }
    if (searchParams.has("error")) {
      throw new OidcAuthError("MY authorization was not completed", 401, "oidc-authorization-denied");
    }
    const code = searchParams.get("code");
    if (!code) throw new OidcAuthError("OIDC authorization code is missing", 400, "oidc-code-missing");

    const discovery = await this.discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: pending.codeVerifier,
    });
    let response;
    try {
      response = await fetch(discovery.tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new OidcAuthError("Cannot reach the MY OIDC token endpoint", 502, "oidc-token-unavailable");
    }
    let tokens;
    try {
      tokens = await response.json();
    } catch {
      throw new OidcAuthError("MY OIDC token response is invalid", 502, "oidc-token-invalid");
    }
    if (!response.ok || typeof tokens.id_token !== "string") {
      throw new OidcAuthError("MY OIDC token exchange failed", 401, "oidc-token-invalid");
    }

    if (!this.jwks || this.jwksUri !== discovery.jwksUri.href) {
      this.jwksUri = discovery.jwksUri.href;
      this.jwks = createRemoteJWKSet(discovery.jwksUri);
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, this.jwks, {
        issuer: this.issuer,
        audience: this.clientId,
        algorithms: ["EdDSA"],
        clockTolerance: 60,
        requiredClaims: ["sub", "preferred_username", "role", "iat", "exp", "nonce", "token_use"],
      }));
    } catch {
      throw new OidcAuthError("MY ID Token validation failed", 401, "oidc-id-token-invalid");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!safeEqual(payload.nonce, pending.nonce)
      || payload.token_use !== "id"
      || !Number.isFinite(payload.iat)
      || payload.iat > nowSeconds + 60
      || payload.iat < nowSeconds - 600) {
      throw new OidcAuthError("MY ID Token claims are invalid", 401, "oidc-id-token-invalid");
    }
    const role = highestRole(payload.role);
    if (!role || ROLE_LEVEL.get(role) < ROLE_LEVEL.get(this.requiredRole)) {
      throw new OidcAuthError("This MY account cannot access MonkeyCode", 403, "oidc-role-insufficient");
    }
    return {
      sub: payload.sub,
      username: payload.preferred_username,
      role,
    };
  }
}
