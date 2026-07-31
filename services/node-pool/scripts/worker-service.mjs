import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const workerDir = path.resolve(path.dirname(scriptFile), "..");
const workerFile = path.join(workerDir, "src", "worker.mjs");
const configFile = path.resolve(process.env.MK_WORKER_CONFIG ?? path.join(workerDir, "worker.config.json"));
const tokenFile = path.join(workerDir, "worker.token");
const stateFile = path.join(workerDir, "worker-service.json");
const logFile = path.join(workerDir, "worker-service.log");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function serviceAlive(pid) {
  if (!alive(pid)) return false;
  if (process.platform !== "linux") return true;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.includes("worker-service.mjs") && commandLine.includes("supervise");
  } catch {
    return false;
  }
}

async function atomicWrite(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, file);
  await chmod(file, mode);
}

async function readServiceState() {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return Number.isInteger(state?.pid) ? state : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeState() {
  await unlink(stateFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function runningState() {
  const state = await readServiceState();
  if (!state || !(await serviceAlive(state.pid))) {
    if (state) await removeState();
    return null;
  }
  return state;
}

function signalService(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (process.platform !== "win32") {
      process.kill(pid, signal);
      return;
    }
    throw error;
  }
}

async function startService() {
  const existing = await runningState();
  if (existing) {
    console.log(`Worker service is already running (PID ${existing.pid})`);
    return existing;
  }
  if (!existsSync(configFile)) throw new Error(`Worker config is missing: ${configFile}`);
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (token.length < 32) throw new Error("Stored Worker token is missing or invalid");

  const output = openSync(logFile, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [scriptFile, "supervise"], {
      cwd: workerDir,
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, MK_WORKER_CONFIG: configFile, MK_WORKER_TOKEN_FILE: tokenFile },
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  const state = { version: 1, pid: child.pid, startedAt: new Date().toISOString(), configFile };
  await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  await delay(300);
  if (!(await serviceAlive(child.pid))) {
    await removeState();
    throw new Error(`Worker service exited during startup; inspect ${logFile}`);
  }
  console.log(`Worker service started (PID ${child.pid})`);
  return state;
}

async function stopService() {
  const state = await runningState();
  if (!state) {
    console.log("Worker service is not running");
    return;
  }
  signalService(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && await serviceAlive(state.pid); attempt += 1) await delay(250);
  if (await serviceAlive(state.pid)) signalService(state.pid, "SIGKILL");
  await removeState();
  console.log("Worker service stopped");
}

async function supervise() {
  let child = null;
  let stopping = false;
  let attempt = 0;

  const shutdown = () => {
    stopping = true;
    if (child && alive(child.pid)) child.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopping) {
    const token = (await readFile(process.env.MK_WORKER_TOKEN_FILE ?? tokenFile, "utf8")).trim();
    if (token.length < 32) throw new Error("Stored Worker token is missing or invalid");
    console.log(`[${new Date().toISOString()}] Starting Worker`);
    const childStartedAt = Date.now();
    child = spawn(process.execPath, [workerFile], {
      cwd: workerDir,
      stdio: "inherit",
      env: {
        ...process.env,
        MK_WORKER_CONFIG: process.env.MK_WORKER_CONFIG ?? configFile,
        MK_WORKER_TOKEN: token,
        MK_WORKER_SERVICE: "1",
      },
    });
    const exit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child = null;
    if (stopping) break;
    attempt = Date.now() - childStartedAt >= 60_000 ? 1 : attempt + 1;
    const waitMs = Math.min(60_000, 1000 * (2 ** Math.min(6, attempt - 1)));
    console.error(`[${new Date().toISOString()}] Worker exited (${exit.error?.message ?? exit.code ?? exit.signal ?? "unknown"}); restarting in ${waitMs / 1000}s`);
    await delay(waitMs);
  }
}

async function installService() {
  const token = String(process.env.MK_WORKER_TOKEN ?? "").trim();
  if (token.length < 32) throw new Error("MK_WORKER_TOKEN is missing or invalid");
  await atomicWrite(tokenFile, `${token}\n`);
  await stopService();
  await startService();
}

async function statusService() {
  const state = await runningState();
  if (!state) {
    console.log("Worker service is not running");
    process.exitCode = 1;
    return;
  }
  console.log(`Worker service is running (PID ${state.pid}, since ${state.startedAt})`);
}

const command = process.argv[2] ?? "status";
if (command === "supervise") await supervise();
else if (command === "install") await installService();
else if (command === "start") await startService();
else if (command === "stop") await stopService();
else if (command === "restart") {
  await stopService();
  await startService();
} else if (command === "status") await statusService();
else throw new Error("Usage: npm run service -- <install|start|stop|restart|status>");
