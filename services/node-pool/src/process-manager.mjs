import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectPublicUrl } from "./config.mjs";

const execFileAsync = promisify(execFile);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error("Project directory must stay inside the worker root");
  return target;
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function runCommand(command, cwd, logFile, timeoutMs = 20 * 60_000) {
  if (!command) return;
  await mkdir(path.dirname(logFile), { recursive: true });
  const output = openSync(logFile, "a");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", output, output],
        env: { ...process.env, CI: "true" },
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Command failed with exit code ${code ?? signal ?? "unknown"}`));
      });
    });
  } finally {
    closeSync(output);
  }
}

async function runProgram(file, args, cwd, logFile, timeoutMs = 20 * 60_000) {
  await mkdir(path.dirname(logFile), { recursive: true });
  const output = openSync(logFile, "a");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        shell: false,
        stdio: ["ignore", output, output],
        env: process.env,
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${file} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${file} failed with exit code ${code ?? signal ?? "unknown"}`));
      });
    });
  } finally {
    closeSync(output);
  }
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

async function processMatchesDirectory(pid, directory) {
  try {
    return path.resolve(await readlink(`/proc/${pid}/cwd`)) === path.resolve(directory);
  } catch {
    return false;
  }
}

export function projectLaunch(project, resourceControl) {
  if (!resourceControl.available || resourceControl.mode === "off") {
    return {
      file: project.start,
      args: [],
      shell: true,
      enforced: false,
    };
  }

  const cpuPercent = Math.max(1, Math.round(project.resources.cpu * 100));
  const memoryMb = Math.max(16, Math.round(project.resources.memoryMb));
  const unitName = `monkeycode-${project.name.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}-${Date.now()}`;
  return {
    file: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--property=CPUQuota=${cpuPercent}%`,
      `--property=MemoryMax=${memoryMb}M`,
      `--property=TasksMax=${resourceControl.maxProcesses}`,
      `--unit=${unitName}`,
      "--",
      "/bin/sh",
      "-lc",
      `exec ${project.start}`,
    ],
    shell: false,
    enforced: true,
  };
}

export class ProjectManager {
  constructor(config, options = {}) {
    this.config = config;
    this.execFile = options.execFile ?? execFileAsync;
    this.root = path.resolve(config.rootDir);
    this.runtimeDir = path.join(this.root, "runtime");
    this.logDir = path.join(this.root, "logs");
    this.stateFile = path.join(this.runtimeDir, "state.json");
    this.state = { version: 1, projects: {} };
    this.resourceControl = {
      ...config.resourceControl,
      available: false,
      reason: config.resourceControl.mode === "off" ? "disabled" : "not-probed",
    };
  }

  async load() {
    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.logDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (parsed?.version === 1 && parsed.projects) this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let migrated = false;
    for (const entry of Object.values(this.state.projects)) {
      if (!entry.desiredStatus) {
        entry.desiredStatus = entry.status === "running" ? "running" : "stopped";
        migrated = true;
      }
      if (!Number.isInteger(entry.restartAttempts)) {
        entry.restartAttempts = 0;
        migrated = true;
      }
      if (!Number.isInteger(entry.healthFailures)) {
        entry.healthFailures = 0;
        migrated = true;
      }
    }
    if (migrated) await this.save();
    await this.detectResourceControl();
    await this.refresh();
  }

  async detectResourceControl() {
    if (this.resourceControl.mode === "off") return this.resourceControl;
    if (process.platform !== "linux") {
      this.resourceControl.reason = "unsupported-platform";
    } else {
      try {
        await this.execFile("systemd-run", [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          "--property=CPUQuota=100%",
          "--property=MemoryMax=64M",
          "--property=TasksMax=8",
          "true",
        ], { timeout: 5_000 });
        this.resourceControl.available = true;
        this.resourceControl.reason = null;
      } catch (error) {
        this.resourceControl.reason = String(error.message ?? error).slice(0, 500);
      }
    }
    if (this.resourceControl.mode === "required" && !this.resourceControl.available) {
      throw new Error(`Required resource control is unavailable: ${this.resourceControl.reason}`);
    }
    return this.resourceControl;
  }

  project(name) {
    const project = this.config.projects[name];
    if (!project) throw new Error(`Project is not allowed on this worker: ${name}`);
    return {
      ...project,
      name,
      directoryPath: inside(this.root, project.directory ?? name),
      resources: {
        cpu: Math.max(0, Number(project.resources?.cpu) || 0.25),
        memoryMb: Math.max(0, Math.round(Number(project.resources?.memoryMb) || 256)),
      },
      publicUrl: projectPublicUrl(this.config, project),
    };
  }

  async save() {
    await atomicWrite(this.stateFile, this.state);
  }

  async refresh() {
    let changed = false;
    for (const [name, entry] of Object.entries(this.state.projects)) {
      const configured = this.config.projects[name];
      if (!configured || entry.status !== "running") continue;
      const project = this.project(name);
      if (!alive(entry.pid) || !(await processMatchesDirectory(entry.pid, project.directoryPath))) {
        entry.status = "stopped";
        entry.stoppedAt = new Date().toISOString();
        entry.lastError = "Managed process exited unexpectedly";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  allocations() {
    return Object.entries(this.state.projects)
      .filter(([name, entry]) => this.config.projects[name] && entry.status === "running" && alive(entry.pid))
      .map(([name, entry]) => {
        const project = this.project(name);
        return {
          project: name,
          pid: entry.pid,
          port: project.port ?? null,
          status: "running",
          desiredStatus: entry.desiredStatus ?? "running",
          resourceControl: entry.resourceControl ?? "none",
          publicUrl: project.publicUrl,
          ...project.resources,
        };
      });
  }

  projectStates() {
    return Object.keys(this.config.projects).sort().map((name) => {
      const project = this.project(name);
      const entry = this.state.projects[name] ?? {};
      return {
        project: name,
        status: entry.status ?? "not-deployed",
        desiredStatus: entry.desiredStatus ?? "stopped",
        pid: Number.isInteger(entry.pid) ? entry.pid : null,
        port: project.port,
        publicUrl: project.publicUrl,
        restartPolicy: project.restartPolicy,
        restartAttempts: entry.restartAttempts ?? 0,
        resourceControl: entry.resourceControl ?? "none",
        lastDeploymentError: entry.lastDeploymentError ?? null,
        lastRollbackAt: entry.lastRollbackAt ?? null,
        lastRollbackError: entry.lastRollbackError ?? null,
        nextRestartAt: entry.nextRestartAt ?? null,
        lastRecoveredAt: entry.lastRecoveredAt ?? null,
        lastError: entry.lastError ?? null,
      };
    });
  }

  async ensureRepository(project, ref, logFile) {
    await mkdir(this.root, { recursive: true });
    if (!existsSync(path.join(project.directoryPath, ".git"))) {
      if (existsSync(project.directoryPath) && (await readdir(project.directoryPath)).length) {
        throw new Error(`Managed project directory is not an empty Git repository: ${project.directoryPath}`);
      }
      await mkdir(path.dirname(project.directoryPath), { recursive: true });
      await runProgram("git", ["clone", "--no-checkout", project.repo, project.directoryPath], this.root, logFile);
    }
    const { stdout: remote } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: project.directoryPath });
    if (remote.trim() !== project.repo) throw new Error("Configured repository does not match the managed checkout origin");
    await runProgram("git", ["fetch", "--prune", "origin"], project.directoryPath, logFile);
    let commit;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `refs/remotes/origin/${ref}^{commit}`], { cwd: project.directoryPath });
      commit = stdout.trim();
    } catch {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: project.directoryPath });
      commit = stdout.trim();
    }
    await execFileAsync("git", ["checkout", "--detach", "--force", commit], { cwd: project.directoryPath });
    return commit;
  }

  async stop(name, options = {}) {
    const project = this.project(name);
    const desiredStatus = options.desiredStatus ?? "stopped";
    const entry = this.state.projects[name] ?? {};
    if (!entry || entry.status !== "running" || !alive(entry.pid)) {
      this.state.projects[name] = {
        ...entry,
        status: "stopped",
        desiredStatus,
        stoppedAt: new Date().toISOString(),
        ...(desiredStatus === "stopped" ? { restartAttempts: 0, healthFailures: 0, nextRestartAt: null, lastError: null } : {}),
      };
      await this.save();
      return { project: name, status: "stopped", desiredStatus, publicUrl: project.publicUrl, alreadyStopped: true };
    }
    if (!(await processMatchesDirectory(entry.pid, project.directoryPath))) {
      throw new Error(`Refusing to stop PID ${entry.pid} because its working directory no longer matches the project`);
    }
    try { process.kill(-entry.pid, "SIGTERM"); } catch { process.kill(entry.pid, "SIGTERM"); }
    for (let attempt = 0; attempt < 20 && alive(entry.pid); attempt += 1) await delay(250);
    if (alive(entry.pid)) {
      try { process.kill(-entry.pid, "SIGKILL"); } catch { process.kill(entry.pid, "SIGKILL"); }
    }
    entry.status = "stopped";
    entry.desiredStatus = desiredStatus;
    entry.stoppedAt = new Date().toISOString();
    if (desiredStatus === "stopped") {
      entry.restartAttempts = 0;
      entry.healthFailures = 0;
      entry.nextRestartAt = null;
      entry.lastError = null;
    }
    await this.save();
    return { project: name, status: "stopped", desiredStatus, publicUrl: project.publicUrl };
  }

  async waitForHealth(project, pid) {
    if (!project.healthPath || !project.port) {
      await delay(1000);
      if (!alive(pid)) throw new Error("Project process exited immediately after startup");
      return null;
    }
    const url = `http://127.0.0.1:${project.port}${project.healthPath}`;
    const deadline = Date.now() + (Number(project.healthTimeoutSeconds) || 30) * 1000;
    let lastError;
    while (Date.now() < deadline) {
      if (!alive(pid)) throw new Error("Project process exited before becoming healthy");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (response.ok) return url;
        lastError = new Error(`Health endpoint returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(1000);
    }
    throw new Error(`Health check failed: ${lastError?.message ?? "timeout"}`);
  }

  async checkHealth(project) {
    if (!project.healthPath || !project.port) return true;
    try {
      const response = await fetch(`http://127.0.0.1:${project.port}${project.healthPath}`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start(name, commit = null, options = {}) {
    const project = this.project(name);
    if (!project.start) throw new Error(`Project start command is missing: ${name}`);
    if (!existsSync(project.directoryPath)) throw new Error(`Project has not been deployed: ${name}`);
    await this.stop(name, { desiredStatus: "running" });
    const previous = this.state.projects[name] ?? {};
    const logFile = path.join(this.logDir, `${name}.log`);
    const output = openSync(logFile, "a");
    const launch = projectLaunch(project, this.resourceControl);
    const child = spawn(launch.file, launch.args, {
      cwd: project.directoryPath,
      shell: launch.shell,
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, PORT: String(project.port ?? process.env.PORT ?? "") },
    });
    closeSync(output);
    child.unref();
    this.state.projects[name] = {
      pid: child.pid,
      status: "running",
      desiredStatus: "running",
      commit: commit ?? this.state.projects[name]?.commit ?? null,
      ref: previous.ref ?? null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      logFile,
      resourceControl: launch.enforced ? "systemd" : "none",
      healthFailures: 0,
      restartAttempts: options.recovery ? previous.restartAttempts ?? 0 : 0,
      nextRestartAt: null,
      lastError: null,
    };
    await this.save();
    try {
      const healthUrl = await this.waitForHealth(project, child.pid);
      const entry = this.state.projects[name];
      entry.restartAttempts = 0;
      entry.nextRestartAt = null;
      entry.lastError = null;
      if (options.recovery) entry.lastRecoveredAt = new Date().toISOString();
      await this.save();
      return { project: name, status: "running", desiredStatus: "running", pid: child.pid, port: project.port ?? null, healthUrl, publicUrl: project.publicUrl };
    } catch (error) {
      await this.stop(name, { desiredStatus: options.recovery ? "running" : "stopped" }).catch(() => {});
      const entry = this.state.projects[name] ?? {};
      entry.lastError = error.message;
      this.state.projects[name] = entry;
      await this.save();
      throw error;
    }
  }

  async deploy(name, ref) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,199}$/.test(ref ?? "")) throw new Error("Invalid Git ref");
    const project = this.project(name);
    const logFile = path.join(this.logDir, `${name}-deploy.log`);
    const previous = structuredClone(this.state.projects[name] ?? {});
    await this.stop(name, { desiredStatus: "stopped" });
    try {
      const commit = await this.ensureRepository(project, ref, logFile);
      await runCommand(project.install, project.directoryPath, logFile);
      await runCommand(project.build, project.directoryPath, logFile);
      this.state.projects[name] = { ...this.state.projects[name], ref, commit };
      await this.save();
      const running = await this.start(name, commit);
      return { ...running, ref, commit };
    } catch (error) {
      const deploymentError = String(error.message ?? error);
      if (previous.commit) {
        try {
          const rollbackCommit = await this.ensureRepository(project, previous.commit, logFile);
          await runCommand(project.install, project.directoryPath, logFile);
          await runCommand(project.build, project.directoryPath, logFile);
          this.state.projects[name] = {
            ...previous,
            pid: null,
            status: "stopped",
            desiredStatus: previous.desiredStatus ?? (previous.status === "running" ? "running" : "stopped"),
            commit: rollbackCommit,
            lastDeploymentError: deploymentError,
            lastRollbackAt: new Date().toISOString(),
            lastRollbackError: null,
          };
          await this.save();
          if (previous.status === "running" || previous.desiredStatus === "running") {
            await this.start(name, rollbackCommit);
          }
          this.state.projects[name] = {
            ...this.state.projects[name],
            ref: previous.ref ?? null,
            commit: rollbackCommit,
            lastDeploymentError: deploymentError,
            lastRollbackAt: new Date().toISOString(),
            lastRollbackError: null,
          };
          await this.save();
          throw new Error(`${deploymentError}; previous release restored`, { cause: error });
        } catch (rollbackError) {
          if (rollbackError.cause === error && /previous release restored$/.test(rollbackError.message)) throw rollbackError;
          const rollbackMessage = String(rollbackError.message ?? rollbackError);
          this.state.projects[name] = {
            ...this.state.projects[name],
            status: "stopped",
            desiredStatus: previous.desiredStatus ?? "stopped",
            lastDeploymentError: deploymentError,
            lastRollbackError: rollbackMessage,
          };
          await this.save();
          throw new Error(`${deploymentError}; rollback failed: ${rollbackMessage}`, { cause: error });
        }
      }
      this.state.projects[name] = {
        ...this.state.projects[name],
        status: "stopped",
        desiredStatus: "stopped",
        lastError: deploymentError,
        lastDeploymentError: deploymentError,
      };
      await this.save();
      throw error;
    }
  }

  recoveryDelay(attempt) {
    const initial = this.config.recovery.initialDelaySeconds * 1000;
    const maximum = this.config.recovery.maxDelaySeconds * 1000;
    return Math.min(maximum, initial * (2 ** Math.max(0, attempt - 1)));
  }

  async reconcile(now = Date.now()) {
    await this.refresh();
    const recoveries = [];
    let changed = false;

    const healthChecks = await Promise.all(Object.keys(this.config.projects).map(async (name) => {
      const entry = this.state.projects[name];
      const project = this.project(name);
      if (!entry || entry.status !== "running" || entry.desiredStatus !== "running" || project.restartPolicy === "never") return null;
      return { name, healthy: await this.checkHealth(project) };
    }));

    for (const check of healthChecks.filter(Boolean)) {
      const entry = this.state.projects[check.name];
      if (check.healthy) {
        if (entry.healthFailures || entry.lastError === "Health check failed repeatedly") {
          entry.healthFailures = 0;
          entry.lastError = null;
          changed = true;
        }
        continue;
      }
      entry.healthFailures = (entry.healthFailures ?? 0) + 1;
      changed = true;
      if (entry.healthFailures < this.config.recovery.healthFailureThreshold) continue;
      entry.lastError = "Health check failed repeatedly";
      await this.stop(check.name, { desiredStatus: "running" });
    }
    if (changed) await this.save();

    for (const name of Object.keys(this.config.projects)) {
      const project = this.project(name);
      const entry = this.state.projects[name];
      if (!entry || entry.desiredStatus !== "running" || entry.status === "running" || project.restartPolicy === "never") continue;
      if (!existsSync(project.directoryPath)) continue;
      if (entry.nextRestartAt && new Date(entry.nextRestartAt).getTime() > now) continue;

      const attempt = (entry.restartAttempts ?? 0) + 1;
      try {
        const result = await this.start(name, entry.commit ?? null, { recovery: true });
        recoveries.push({ ...result, recovered: true });
      } catch (error) {
        const current = this.state.projects[name] ?? {};
        current.status = "stopped";
        current.desiredStatus = "running";
        current.restartAttempts = attempt;
        current.nextRestartAt = new Date(now + this.recoveryDelay(attempt)).toISOString();
        current.lastError = error.message;
        this.state.projects[name] = current;
        await this.save();
        recoveries.push({ project: name, status: "failed", error: error.message, nextRestartAt: current.nextRestartAt });
      }
    }
    return recoveries;
  }

  async execute(job) {
    if (job.type === "deploy") return this.deploy(job.project, job.ref);
    if (job.type === "start") return this.start(job.project);
    if (job.type === "stop") return this.stop(job.project, { desiredStatus: "stopped" });
    if (job.type === "restart") return this.start(job.project);
    throw new Error(`Unsupported job type: ${job.type}`);
  }
}
