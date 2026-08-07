import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:4180");
const password = process.env.SMOKE_PANEL_PASSWORD ?? "";
assert.ok(password.length >= 12, "SMOKE_PANEL_PASSWORD is required");

const ready = await fetch(new URL("/api/readyz", baseUrl));
assert.equal(ready.status, 200);
assert.equal((await ready.json()).ok, true);

const login = await fetch(new URL("/api/auth/login", baseUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
assert.ok(cookie, "Panel login did not return a session cookie");

const settings = await fetch(new URL("/api/settings", baseUrl), {
  headers: { Cookie: cookie },
});
assert.equal(settings.status, 200);
const payload = await settings.json();
assert.equal(typeof payload.enabled, "boolean");
assert.ok(payload.operationsSettings);
assert.ok(Array.isArray(payload.notifications));

console.log("Panel smoke flow passed");
