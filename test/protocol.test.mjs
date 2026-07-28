import assert from "node:assert/strict";
import test from "node:test";

import {
  dayKey,
  encodeUserInput,
  isDuplicateHistory,
  promptPreview,
  timestampToDate,
} from "../src/protocol.mjs";

test("encodes the frontend-compatible user-input payload", () => {
  const encoded = JSON.parse(encodeUserInput("每天总结一下"));
  assert.equal(encoded.type, "user-input");
  const inner = JSON.parse(Buffer.from(encoded.data, "base64").toString("utf8"));
  assert.equal(Buffer.from(inner.content, "base64").toString("utf8"), "每天总结一下");
  assert.deepEqual(inner.attachments, []);
});

test("handles nanosecond timestamps and timezone day keys", () => {
  const date = timestampToDate("1785081600000000000");
  assert.equal(date.toISOString(), "2026-07-26T16:00:00.000Z");
  assert.equal(dayKey(date, "Asia/Shanghai"), "2026-07-27");
});

test("deduplicates a truncated Unicode prompt on the same local day", () => {
  const prompt = "你".repeat(600);
  const now = new Date("2026-07-27T05:00:00.000Z");
  assert.equal(Array.from(promptPreview(prompt)).length, 500);
  assert.equal(isDuplicateHistory([
    { content: promptPreview(prompt), truncated: true, timestamp: "1785128400000000000" },
  ], prompt, now, "Asia/Shanghai"), true);
});

test("does not deduplicate the same prompt from a previous local day", () => {
  const now = new Date("2026-07-27T05:00:00.000Z");
  assert.equal(isDuplicateHistory([
    { content: "hello", truncated: false, timestamp: "1784995200000000000" },
  ], "hello", now, "Asia/Shanghai"), false);
});
