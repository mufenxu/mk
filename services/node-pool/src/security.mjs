import { createHmac, timingSafeEqual } from "node:crypto";

export function deriveWorkerToken(secret, nodeId) {
  if (!secret || secret.length < 32) throw new Error("MK_WORKER_SECRET must contain at least 32 characters");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nodeId)) throw new Error("Invalid worker node id");
  return createHmac("sha256", secret).update(`worker:${nodeId}`).digest("base64url");
}

export function bearerToken(request) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
