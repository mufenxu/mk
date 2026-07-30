#!/usr/bin/env node

import path from "node:path";

import { AutoLoginService } from "./auto-login.mjs";
import { BrowserBridgeService } from "./browser-bridge.mjs";
import { EnvironmentKeeper } from "./environment-keeper.mjs";
import { ConfigError } from "./errors.mjs";
import { NotificationService } from "./notifications.mjs";
import { RemoteSyncService } from "./remote-sync.mjs";
import { TaskRunner } from "./runner.mjs";
import { parseMasterKey } from "./security.mjs";
import { PanelServer } from "./server.mjs";
import { DataStore } from "./storage.mjs";

function panelConfig(env = process.env) {
  const password = env.MONKEYCODE_PANEL_PASSWORD;
  if (!password || password.length < 12) {
    throw new ConfigError("MONKEYCODE_PANEL_PASSWORD must contain at least 12 characters");
  }
  const port = Number(env.MONKEYCODE_PANEL_PORT || 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("MONKEYCODE_PANEL_PORT is invalid");
  return {
    password,
    masterKey: parseMasterKey(env.MONKEYCODE_MASTER_KEY),
    dataDir: path.resolve(env.MONKEYCODE_DATA_DIR || "./data"),
    host: env.MONKEYCODE_PANEL_HOST || "127.0.0.1",
    port,
    secureCookie: env.MONKEYCODE_SECURE_COOKIE === "true",
    browserBridgeEnabled: env.MONKEYCODE_BROWSER_BRIDGE_ENABLED === "true",
  };
}

try {
  const config = panelConfig();
  const store = await new DataStore(config.dataDir, config.masterKey).init();
  const notifications = new NotificationService(store);
  const autoLogin = new AutoLoginService(store, notifications);
  const runner = new TaskRunner(store, notifications, { autoLogin });
  const environmentKeeper = new EnvironmentKeeper(store);
  const remoteSync = new RemoteSyncService(store, notifications);
  const browserBridge = config.browserBridgeEnabled ? new BrowserBridgeService(store) : null;
  const server = new PanelServer({ ...config, store, notifications, runner, browserBridge, remoteSync, environmentKeeper, autoLogin });
  await environmentKeeper.start();
  const address = await server.listen();
  autoLogin.start();
  runner.startScheduler();
  remoteSync.start();
  console.log(`MonkeyCode control panel listening on http://${address.address}:${address.port}`);

  const shutdown = async () => {
    runner.stopScheduler();
    autoLogin.stop();
    remoteSync.stop();
    environmentKeeper.stop();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(`${error.name ?? "Error"}: ${error.message}`);
  process.exitCode = 2;
}
