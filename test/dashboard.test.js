import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../src/dashboard.js";

async function startDashboard(t, getSnapshot, onVideoCommand) {
  const dashboard = createDashboardServer({ getSnapshot, onVideoCommand });
  await new Promise((resolve, reject) => {
    dashboard.server.once("error", reject);
    dashboard.server.listen(0, "127.0.0.1", resolve);
  });

  const address = dashboard.server.address();
  assert.ok(address && typeof address === "object");
  t.after(
    () =>
      new Promise((resolve) => {
        dashboard.server.close(() => resolve());
        dashboard.server.closeAllConnections();
      }),
  );

  return {
    dashboard,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("serves the dashboard and its current status over HTTP", async (t) => {
  const snapshot = {
    listener: { protocol: "JT808", publishedPort: 6608, containerPort: 7611 },
    terminals: [{ terminalId: "8005318", connected: true }],
    events: [],
  };
  const { baseUrl } = await startDashboard(t, () => snapshot);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /Monitor JT808/);

  const status = await fetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), snapshot);
});

test("streams a fresh dashboard snapshot to connected browsers", async (t) => {
  let snapshot = {
    listener: { protocol: "JT808" },
    terminals: [],
    events: [],
  };
  const { baseUrl, dashboard } = await startDashboard(t, () => snapshot);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const response = await fetch(`${baseUrl}/api/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert.match(initial, /"terminals":\[\]/);

  snapshot = {
    ...snapshot,
    terminals: [{ terminalId: "8005318", connected: true }],
  };
  dashboard.publish();

  const update = decoder.decode((await reader.read()).value);
  assert.match(update, /8005318/);
  controller.abort();
});

test("rejects methods other than GET and unknown routes", async (t) => {
  const { baseUrl } = await startDashboard(t, () => ({
    listener: {},
    terminals: [],
    events: [],
  }));

  const post = await fetch(`${baseUrl}/api/status`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");

  const missing = await fetch(`${baseUrl}/not-a-route`);
  assert.equal(missing.status, 404);
});

test("dispatches valid local video commands to the JT808 handler", async (t) => {
  const commands = [];
  const { baseUrl } = await startDashboard(t, () => ({
    listener: {},
    terminals: [],
    events: [],
  }), async (command) => {
    commands.push(command);
    return { status: "sent", messageId: "0x9101" };
  });

  const response = await fetch(
    `${baseUrl}/api/terminals/8005318/video/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelNo: 2 }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    status: "sent",
    messageId: "0x9101",
  });
  assert.deepEqual(commands, [
    {
      terminalId: "8005318",
      action: "start",
      parameters: { channelNo: 2 },
    },
  ]);
});

test("dispatches the resync action without requiring a channelNo", async (t) => {
  const commands = [];
  const { baseUrl } = await startDashboard(t, () => ({
    listener: {},
    terminals: [],
    events: [],
  }), async (command) => {
    commands.push(command);
    return { status: "resyncing", channels: [1, 2] };
  });

  const response = await fetch(
    `${baseUrl}/api/terminals/8005318/video/resync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    status: "resyncing",
    channels: [1, 2],
  });
  assert.deepEqual(commands, [
    {
      terminalId: "8005318",
      action: "resync",
      parameters: {},
    },
  ]);
});

test("validates video command paths, content type, and JSON body", async (t) => {
  const { baseUrl } = await startDashboard(
    t,
    () => ({ listener: {}, terminals: [], events: [] }),
    async () => ({ status: "sent" }),
  );

  const invalidTerminal = await fetch(
    `${baseUrl}/api/terminals/not-a-number/video/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(invalidTerminal.status, 400);

  const wrongType = await fetch(
    `${baseUrl}/api/terminals/8005318/video/start`,
    { method: "POST", body: "{}" },
  );
  assert.equal(wrongType.status, 415);

  const invalidJson = await fetch(
    `${baseUrl}/api/terminals/8005318/video/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[",
    },
  );
  assert.equal(invalidJson.status, 400);

  const fallback = await startDashboard(
    t,
    () => ({ listener: {}, terminals: [], events: [] }),
  );
  const unavailable = await fetch(
    `${fallback.baseUrl}/api/terminals/8005318/video/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(unavailable.status, 501);
});
