import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { sendNotification } from "../src/notifications.mjs";

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
