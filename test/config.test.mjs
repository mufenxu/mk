import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { ConfigError } from "../src/errors.mjs";

const taskId = "678fed52-b2a8-467f-a94c-3b0fde6f1c89";

test("loads a prompt file without retaining trailing line breaks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-config-"));
  const promptFile = path.join(directory, "prompt.txt");
  try {
    await writeFile(promptFile, "daily prompt\n\n", "utf8");
    const config = await loadConfig({
      MONKEYCODE_BASE_URL: "https://monkeycode-ai.com",
      MONKEYCODE_TASK_ID: taskId,
      MONKEYCODE_SESSION: "valid-session_value",
      MONKEYCODE_PROMPT_FILE: promptFile,
      MONKEYCODE_DRY_RUN: "false",
    });
    assert.equal(config.prompt, "daily prompt");
    assert.equal(config.dryRun, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects insecure non-local base URLs", async () => {
  await assert.rejects(
    loadConfig({
      MONKEYCODE_BASE_URL: "http://example.com",
      MONKEYCODE_TASK_ID: taskId,
      MONKEYCODE_SESSION: "valid-session",
      MONKEYCODE_PROMPT: "daily prompt",
    }),
    ConfigError,
  );
});

test("rejects cookie injection characters", async () => {
  await assert.rejects(
    loadConfig({
      MONKEYCODE_TASK_ID: taskId,
      MONKEYCODE_SESSION: "value; another=cookie",
      MONKEYCODE_PROMPT: "daily prompt",
    }),
    ConfigError,
  );
});
