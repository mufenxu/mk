const controllerUrl = (process.env.MK_CONTROLLER_URL ?? "http://127.0.0.1:4191").replace(/\/$/, "");
const token = process.env.MK_ADMIN_TOKEN ?? "";
if (token.length < 24) throw new Error("MK_ADMIN_TOKEN is missing or invalid");

const response = await fetch(`${controllerUrl}/api/status`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30_000),
});
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Controller returned HTTP ${response.status}: ${result.error ?? "unknown error"}`);
console.log(JSON.stringify(result, null, 2));
