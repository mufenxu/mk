import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";

import { checkSession, runOnce } from "../src/client.mjs";
import { AuthExpiredError, CancelledError } from "../src/errors.mjs";

const session = "test-session-value";
const taskId = "678fed52-b2a8-467f-a94c-3b0fde6f1c89";

async function createMock({ history = [], authenticated = true, acknowledge = true } = {}) {
  let websocketConnections = 0;
  let receivedPrompt = null;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (!authenticated || request.headers.cookie !== `monkeycode_ai_session=${session}`) {
      response.end(JSON.stringify({ code: 0, data: null }));
      return;
    }
    if (request.url === "/api/v1/users/status") {
      response.end(JSON.stringify({ code: 0, data: { user: { id: "user-1" } } }));
      return;
    }
    if (request.url?.startsWith("/api/v1/users/tasks/user-inputs?")) {
      response.end(JSON.stringify({ code: 0, data: { items: history } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404 }));
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (
      authenticated
      && request.headers.cookie === `monkeycode_ai_session=${session}`
      && url.pathname === "/api/v1/users/tasks/stream"
      && url.searchParams.get("id") === taskId
      && url.searchParams.get("mode") === "new"
    ) {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        websocketConnections += 1;
        webSocketServer.emit("connection", webSocket, request);
      });
    } else {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.on("message", (raw) => {
      const event = JSON.parse(raw.toString("utf8"));
      const inner = JSON.parse(Buffer.from(event.data, "base64").toString("utf8"));
      receivedPrompt = Buffer.from(inner.content, "base64").toString("utf8");
      if (acknowledge) webSocket.send(JSON.stringify({ type: "user-input", data: event.data }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    get websocketConnections() { return websocketConnections; },
    get receivedPrompt() { return receivedPrompt; },
    close: async () => {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeConfig(baseUrl, stateFile, overrides = {}) {
  return {
    baseUrl,
    taskId,
    session,
    prompt: "生成今天的项目进展摘要",
    timeZone: "Asia/Shanghai",
    timeoutMs: 2_000,
    historyLimit: 20,
    stateFile,
    dryRun: false,
    ...overrides,
  };
}

test("sends once, waits for acknowledgement, and records local state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-daily-"));
  const mock = await createMock();
  const stateFile = path.join(directory, "state.json");
  try {
    const result = await runOnce(makeConfig(mock.baseUrl, stateFile), {
      now: new Date("2026-07-27T01:00:00.000Z"),
    });
    assert.equal(result.status, "sent");
    assert.equal(mock.websocketConnections, 1);
    assert.equal(mock.receivedPrompt, "生成今天的项目进展摘要");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.day, "2026-07-27");
    assert.equal(state.taskId, taskId);
    assert.match(state.promptHash, /^[0-9a-f]{64}$/);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("skips a matching remote input without opening a WebSocket", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-daily-"));
  const mock = await createMock({
    history: [{
      content: "生成今天的项目进展摘要",
      truncated: false,
      timestamp: "1785114000000000000",
    }],
  });
  try {
    const result = await runOnce(makeConfig(mock.baseUrl, path.join(directory, "state.json")), {
      now: new Date("2026-07-27T01:00:00.000Z"),
    });
    assert.equal(result.status, "duplicate");
    assert.equal(result.source, "remote-history");
    assert.equal(mock.websocketConnections, 0);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats an anonymous status response as expired authentication", async () => {
  const mock = await createMock({ authenticated: false });
  try {
    await assert.rejects(
      checkSession(makeConfig(mock.baseUrl, "unused")),
      AuthExpiredError,
    );
  } finally {
    await mock.close();
  }
});

test("cancels an in-flight WebSocket send", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "monkeycode-daily-"));
  const mock = await createMock({ acknowledge: false });
  const controller = new AbortController();
  try {
    const run = runOnce(makeConfig(mock.baseUrl, path.join(directory, "state.json"), { signal: controller.signal }));
    for (let attempt = 0; attempt < 20 && !mock.receivedPrompt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(mock.receivedPrompt, "生成今天的项目进展摘要");
    controller.abort();
    await assert.rejects(run, CancelledError);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
