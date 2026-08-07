import { randomUUID } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";

export async function readRecentJsonLines(filename, {
  limit = 200,
  matches = () => true,
  chunkSize = 64 * 1024,
} = {}) {
  const file = await open(filename, "r");
  try {
    const { size } = await file.stat();
    const records = [];
    let position = size;
    let remainder = Buffer.alloc(0);

    while (position > 0 && records.length < limit) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      const chunk = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
      let end = chunk.length;

      while (records.length < limit) {
        const newline = chunk.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const line = chunk.subarray(newline + 1, end);
        end = newline;
        if (!line.length) continue;
        try {
          const entry = JSON.parse(line.toString("utf8"));
          if (matches(entry)) records.push(entry);
        } catch {
          // Ignore malformed historical log lines and continue with older entries.
        }
      }
      remainder = chunk.subarray(0, end);
    }

    if (records.length < limit && remainder.length) {
      try {
        const entry = JSON.parse(remainder.toString("utf8"));
        if (matches(entry)) records.push(entry);
      } catch {
        // Ignore a malformed first line for consistency with existing log reads.
      }
    }
    return records;
  } finally {
    await file.close();
  }
}

export class JsonLineLogStore {
  constructor(file, settings) {
    this.file = file;
    this.settings = settings;
    this.serial = Promise.resolve();
    this.lastPruneAt = 0;
  }

  wait() {
    return this.serial;
  }

  append(entry) {
    const line = `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry })}\n`;
    this.serial = this.serial.catch(() => {}).then(async () => {
      await writeFile(this.file, line, { encoding: "utf8", flag: "a", mode: 0o600 });
      if (Date.now() - this.lastPruneAt >= 6 * 60 * 60_000) {
        this.lastPruneAt = Date.now();
        await this.prune();
      }
    });
    return this.serial;
  }

  async prune() {
    let content;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const settings = this.settings();
    const cutoff = Date.now() - settings.logRetentionDays * 86_400_000;
    const lines = content.trim().split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
      try { return new Date(JSON.parse(line).at).getTime() >= cutoff; } catch { return false; }
    }).slice(-settings.maxLogEntries);
    if (kept.length === lines.length) return;
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.file);
  }

  async applyRetention() {
    await this.serial.catch(() => {});
    this.lastPruneAt = Date.now();
    await this.prune();
  }

  async read({ limit = 200, taskId, status } = {}) {
    try {
      return await readRecentJsonLines(this.file, {
        limit,
        matches: (entry) => (!taskId || entry.taskId === taskId) && (!status || entry.status === status),
      });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  clear() {
    this.serial = this.serial.catch(() => {}).then(() => writeFile(this.file, "", { encoding: "utf8", mode: 0o600 }));
    return this.serial;
  }
}
