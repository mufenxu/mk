import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const extensionDir = path.resolve("extension");

test("Chrome extension manifest keeps permissions scoped and all referenced assets present", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["https://monkeycode-ai.com/*"]);
  assert.equal(manifest.optional_host_permissions.includes("<all_urls>"), false);
  assert.equal(manifest.permissions.includes("webRequest"), false);
  assert.equal(manifest.permissions.includes("tabs"), false);

  const referenced = [
    manifest.background.service_worker,
    manifest.options_page,
    manifest.action.default_icon,
    ...Object.values(manifest.icons),
    "options.css",
    "options.js",
  ];
  await Promise.all([...new Set(referenced)].map((file) => access(path.join(extensionDir, file))));
});
