import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readRecentJsonLines } from "../src/storage.mjs";

test("reads the newest matching JSONL records from the file tail across chunk boundaries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-logs-"));
  const file = path.join(directory, "runs.jsonl");
  try {
    const lines = [
      { id: "old", status: "sent", detail: "早期记录" },
      { id: "skip", status: "failed", detail: "不匹配" },
      { id: "newer", status: "sent", detail: "跨越分块的中文内容" },
      { id: "latest", status: "sent", detail: "最新记录" },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const records = await readRecentJsonLines(file, {
      limit: 2,
      chunkSize: 17,
      matches: (entry) => entry.status === "sent",
    });

    assert.deepEqual(records.map((entry) => entry.id), ["latest", "newer"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
