#!/usr/bin/env node

import { runOnce } from "./client.mjs";
import { loadConfig } from "./config.mjs";
import { AuthExpiredError, ConfigError } from "./errors.mjs";

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

try {
  const config = await loadConfig();
  await runOnce(config, { log });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof AuthExpiredError) {
    console.error("Authentication expired: update MONKEYCODE_SESSION from a signed-in browser (cookie value is not logged).");
    process.exitCode = 3;
  } else {
    console.error(`${error.name ?? "Error"}: ${error.message}`);
    process.exitCode = 4;
  }
}
