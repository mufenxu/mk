import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("worker service installs, reports status, and stops its supervisor", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-pool-service-"));
  const serviceFile = path.join(root, "scripts", "worker-service.mjs");
  const run = (command, env = {}) => execFileAsync(process.execPath, [serviceFile, command], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 20_000,
  });

  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await cp(path.join(sourceRoot, "src"), path.join(root, "src"), { recursive: true });
    await copyFile(path.join(sourceRoot, "scripts", "worker-service.mjs"), serviceFile);
    await copyFile(path.join(sourceRoot, "package.json"), path.join(root, "package.json"));
    await writeFile(path.join(root, "worker.config.json"), JSON.stringify({
      version: 1,
      nodeId: "service-test",
      controllerUrl: "http://127.0.0.1:9",
      rootDir: path.join(root, "data"),
      projects: {},
    }));

    const installed = await run("install", { MK_WORKER_TOKEN: "a".repeat(48) });
    assert.match(installed.stdout, /Worker service started/);
    const status = await run("status");
    assert.match(status.stdout, /Worker service is running/);
    const stopped = await run("stop");
    assert.match(stopped.stdout, /Worker service stopped/);
  } finally {
    await run("stop").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
