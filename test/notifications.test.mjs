import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sendNotification } from "../src/notifications.mjs";
import { DataStore } from "../src/storage.mjs";

test("sends a structured generic webhook notification", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await sendNotification({
      type: "generic",
      settings: {},
      secret: { webhookUrl: `http://127.0.0.1:${address.port}/notify` },
    }, "sent", {
      taskName: "Daily report",
      detail: "MonkeyCode acknowledged the message",
      at: "2026-07-27T01:00:00.000Z",
    });
    assert.equal(received.event, "sent");
    assert.equal(received.taskName, "Daily report");
    assert.match(received.message, /发送成功/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("notification channels retain node-pool operations events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monkeycode-notifications-"));
  try {
    const store = await new DataStore(directory, randomBytes(32)).init();
    const events = ["node-pool-unavailable", "node-offline", "deployment-failed", "deployment-backlog"];
    const channel = await store.upsertNotification({
      name: "Operations",
      type: "generic",
      enabled: true,
      events,
      settings: {},
      secret: { webhookUrl: "https://example.test/notify" },
    });
    assert.deepEqual(channel.events, events);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
