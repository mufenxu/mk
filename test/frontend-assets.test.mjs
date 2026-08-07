import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

test("generated Lucide subset is current and substantially smaller than the full browser bundle", async () => {
  const { buildLucideSubset } = await import("../scripts/build-icons.mjs");
  const generated = await buildLucideSubset();
  const current = await readFile(path.join(root, "web", "lucide.js"), "utf8");
  const full = await stat(path.join(root, "node_modules", "lucide", "dist", "umd", "lucide.js"));

  assert.equal(current, generated.source);
  assert.ok(generated.icons.length >= 40);
  assert.ok(Buffer.byteLength(current) < full.size / 3);
});

test("frontend catalog is loaded before the application and exposes stable labels", async () => {
  const index = await readFile(path.join(root, "web", "index.html"), "utf8");
  assert.ok(index.indexOf('/catalog.js') < index.indexOf('/app.js'));

  const source = await readFile(path.join(root, "web", "catalog.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.MonkeyCodeCatalog.pageMeta.deployments[0], "项目部署");
  assert.equal(sandbox.window.MonkeyCodeCatalog.notificationEventLabels["node-offline"], "部署节点离线");
});
