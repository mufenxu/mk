import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StateStore } from "../src/state-store.mjs";

test("transient worker updates remain available without rewriting the state file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-pool-state-"));
  const file = path.join(directory, "state.json");
  try {
    const store = new StateStore(file);
    await store.load();
    const persistedBefore = await readFile(file, "utf8");

    await store.mutate((state) => {
      state.workers["worker-01"] = { id: "worker-01", lastSeenAt: new Date().toISOString() };
    }, { persist: false });

    assert.equal(await readFile(file, "utf8"), persistedBefore);
    assert.equal((await store.read()).workers["worker-01"].id, "worker-01");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
