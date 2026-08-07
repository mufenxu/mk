import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/docker.yml", import.meta.url);

test("Node Pool image smoke uses a Fetch-compatible host port", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /--publish 127\.0\.0\.1:4191:4191/);
  assert.match(workflow, /curl .*http:\/\/127\.0\.0\.1:4191\/readyz/);
  assert.match(workflow, /smoke-controller\.mjs http:\/\/127\.0\.0\.1:4191/);
});
