import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

export class ProjectManager {
  constructor(config) {
    this.config = config;
    this.root = path.resolve(config.rootDir);
    this.runtimeDir = path.join(this.root, "runtime");
    this.logDir = path.join(this.root, "logs");
    this.stateFile = path.join(this.runtimeDir, "state.json");
    this.state = { version: 1, projects: {} };
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
    await this.refresh();
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
    };
  }

  async save() {
    await atomicWrite(this.stateFile, this.state);
  }

  async refresh() {
    let changed = false;
    for (const entry of Object.values(this.state.projects)) {
      if (entry.status === "running" && !alive(entry.pid)) {
        entry.status = "stopped";
        entry.stoppedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  allocations() {
    return Object.entries(this.state.projects)
      .filter(([, entry]) => entry.status === "running" && alive(entry.pid))
      .map(([name, entry]) => {
        const project = this.project(name);
        return {
          project: name,
          pid: entry.pid,
          port: project.port ?? null,
          status: "running",
          ...project.resources,
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

  async stop(name) {
    const project = this.project(name);
    const entry = this.state.projects[name];
    if (!entry || entry.status !== "running" || !alive(entry.pid)) {
      this.state.projects[name] = { ...entry, status: "stopped", stoppedAt: new Date().toISOString() };
      await this.save();
      return { project: name, status: "stopped", alreadyStopped: true };
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
    entry.stoppedAt = new Date().toISOString();
    await this.save();
    return { project: name, status: "stopped" };
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

  async start(name, commit = null) {
    const project = this.project(name);
    if (!project.start) throw new Error(`Project start command is missing: ${name}`);
    if (!existsSync(project.directoryPath)) throw new Error(`Project has not been deployed: ${name}`);
    await this.stop(name);
    const logFile = path.join(this.logDir, `${name}.log`);
    const output = openSync(logFile, "a");
    const child = spawn(project.start, {
      cwd: project.directoryPath,
      shell: true,
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, PORT: String(project.port ?? process.env.PORT ?? "") },
    });
    closeSync(output);
    child.unref();
    this.state.projects[name] = {
      pid: child.pid,
      status: "running",
      commit: commit ?? this.state.projects[name]?.commit ?? null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      logFile,
    };
    await this.save();
    try {
      const healthUrl = await this.waitForHealth(project, child.pid);
      return { project: name, status: "running", pid: child.pid, port: project.port ?? null, healthUrl };
    } catch (error) {
      await this.stop(name).catch(() => {});
      throw error;
    }
  }

  async deploy(name, ref) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,199}$/.test(ref ?? "")) throw new Error("Invalid Git ref");
    const project = this.project(name);
    const logFile = path.join(this.logDir, `${name}-deploy.log`);
    await this.stop(name);
    const commit = await this.ensureRepository(project, ref, logFile);
    await runCommand(project.install, project.directoryPath, logFile);
    await runCommand(project.build, project.directoryPath, logFile);
    const running = await this.start(name, commit);
    return { ...running, ref, commit };
  }

  async execute(job) {
    if (job.type === "deploy") return this.deploy(job.project, job.ref);
    if (job.type === "start") return this.start(job.project);
    if (job.type === "stop") return this.stop(job.project);
    if (job.type === "restart") {
      await this.stop(job.project);
      return this.start(job.project);
    }
    throw new Error(`Unsupported job type: ${job.type}`);
  }
}
