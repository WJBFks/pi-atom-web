import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../extensions/server.ts";

const initial = {
  schemaVersion: 1,
  sessionId: "session-a",
  instanceId: "instance-a",
  name: "测试会话",
  cwd: "C:/workspace",
  messages: [{ id: "session-a:entry-1", role: "user", content: "历史" }],
  liveMessage: null,
  tools: [],
  requests: [],
};

async function connect(url) {
  const endpoint = new URL("/api/events", url);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${new URL(url).hash.slice(1)}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      while (!buffer.includes("\n\n"))
        buffer += decoder.decode((await reader.read()).value, { stream: true });
      const boundary = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      return JSON.parse(frame.slice(6));
    },
    close() {
      return reader.cancel();
    },
  };
}

test("SSE sends a snapshot then field patches without history", async (t) => {
  let current = initial;
  const server = await startServer({
    snapshot: () => current,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await connect(server.url);
  t.after(() => client.close());

  const first = await client.next();
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.snapshot, initial);
  server.publish({
    liveMessage: { id: "session-a:run-1", role: "assistant", content: "流式" },
  });
  const second = await client.next();
  assert.deepEqual(second.patch, {
    liveMessage: { id: "session-a:run-1", role: "assistant", content: "流式" },
  });
  assert.equal(second.snapshot, undefined);
  assert.equal(second.patch.messages, undefined);
  assert.equal(second.sequence, first.sequence + 1);
});

test("snapshot validation follows JSON wire semantics for optional undefined fields", async (t) => {
  const current = {
    ...initial,
    messages: [
      {
        id: "session-a:entry-optional",
        role: "assistant",
        content: [{ type: "text", text: "ready", optional: undefined }],
      },
    ],
  };
  const server = await startServer({
    snapshot: () => current,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await connect(server.url);
  t.after(() => client.close());

  const event = await Promise.race([
    client.next(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("initial snapshot missing")), 300),
    ),
  ]);
  assert.deepEqual(event.snapshot.messages[0].content[0], {
    type: "text",
    text: "ready",
  });
});

test("an unserializable patch is skipped without disconnecting SSE or consuming sequence", async (t) => {
  const server = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await connect(server.url);
  t.after(() => client.close());
  const first = await client.next();
  const circular = {};
  circular.self = circular;

  server.publish({ tools: [{ toolCallId: "bad", partialResult: circular }] });
  server.publish({ busy: true });

  const next = await Promise.race([
    client.next(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SSE connection was destroyed")), 500),
    ),
  ]);
  assert.deepEqual(next.patch, { busy: true });
  assert.equal(next.sequence, first.sequence + 1);
});

test("SSE reconnect and session switch receive snapshots", async (t) => {
  let current = initial;
  const server = await startServer({
    snapshot: () => current,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await connect(server.url);
  t.after(() => client.close());
  const first = await client.next();
  current = {
    ...initial,
    sessionId: "session-b",
    name: "第二个会话",
    messages: [],
  };
  server.publish({}, current.sessionId);
  const switched = await client.next();
  assert.equal(switched.type, "snapshot");
  assert.equal(switched.sessionId, "session-b");
  assert.deepEqual(switched.snapshot, current);
  const reconnect = await connect(server.url);
  t.after(() => reconnect.close());
  const restored = await reconnect.next();
  assert.equal(restored.type, "snapshot");
  assert.equal(restored.sessionId, "session-b");
  assert.notEqual(restored.streamId, first.streamId);
});

test("an unserializable session snapshot keeps SSE alive until a valid snapshot is available", async (t) => {
  let current = initial;
  const server = await startServer({
    snapshot: () => current,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await connect(server.url);
  t.after(() => client.close());
  const first = await client.next();
  const circular = {};
  circular.self = circular;
  current = {
    ...initial,
    sessionId: "session-b",
    tools: [{ toolCallId: "bad", partialResult: circular }],
  };
  server.publish({}, current.sessionId);
  current = { ...initial, sessionId: "session-b", tools: [] };
  server.publish({}, current.sessionId);

  const recovered = await Promise.race([
    client.next(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("valid replacement snapshot missing")),
        500,
      ),
    ),
  ]);
  assert.equal(recovered.type, "snapshot");
  assert.equal(recovered.sessionId, "session-b");
  assert.notEqual(recovered.streamId, first.streamId);
  assert.equal(recovered.sequence, 0);
});

test("an invalid initial snapshot can recover on the same SSE connection", async (t) => {
  let current = { ...initial, sessionId: "" };
  const server = await startServer({
    snapshot: () => current,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const client = await Promise.race([
    connect(server.url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SSE headers were not flushed")), 500),
    ),
  ]);
  t.after(() => client.close());
  current = initial;
  server.publish({}, initial.sessionId);
  const recovered = await Promise.race([
    client.next(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("initial snapshot did not recover")),
        500,
      ),
    ),
  ]);
  assert.equal(recovered.type, "snapshot");
  assert.equal(recovered.sessionId, initial.sessionId);
  assert.equal(recovered.sequence, 0);
});

test("action endpoint validates payload before invoking the handler", async (t) => {
  let called = false;
  const server = await startServer({
    snapshot: () => initial,
    action: async () => {
      called = true;
      return {};
    },
  });
  t.after(() => server.close());
  const response = await fetch(new URL("/api/action", server.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${new URL(server.url).hash.slice(1)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "send",
      sessionId: "session-a",
      text: "",
      mode: "followUp",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("serves only the local ESM dependency whitelist with an import-map CSP hash", async (t) => {
  const server = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
  });
  t.after(() => server.close());
  const vue = await fetch(new URL("/vendor/vue.js", server.url));
  assert.equal(vue.status, 200);
  const unknown = await fetch(new URL("/vendor/not-allowed.js", server.url), {
    headers: { Authorization: `Bearer ${new URL(server.url).hash.slice(1)}` },
  });
  assert.equal(unknown.status, 404);
  const page = await fetch(new URL("/", server.url));
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self' 'sha256-[^']+'/,
  );
});
