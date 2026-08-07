import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function initialState() {
  return {
    version: 1,
    workers: {},
    workerCredentials: {},
    revokedWorkers: {},
    jobs: [],
    updatedAt: new Date().toISOString(),
  };
}

export class StateStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = initialState();
    this.serial = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version !== 1 || !parsed.workers || !Array.isArray(parsed.jobs)) {
        throw new Error("Unsupported state file format");
      }
      parsed.workerCredentials ??= {};
      parsed.revokedWorkers ??= {};
      this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async read(reader = (state) => state) {
    await this.serial;
    return structuredClone(reader(this.state));
  }

  async readiness() {
    await this.serial;
    await access(path.dirname(this.file), constants.R_OK | constants.W_OK);
    await access(this.file, constants.R_OK | constants.W_OK);
    return { version: this.state.version };
  }

  async mutate(mutator, { persist = true } = {}) {
    let result;
    const operation = this.serial.then(async () => {
      result = await mutator(this.state);
      if (typeof persist === "function" ? persist(result) : persist) {
        this.state.updatedAt = new Date().toISOString();
        await this.save();
      }
    });
    this.serial = operation.catch(() => {});
    await operation;
    return structuredClone(result);
  }
}
