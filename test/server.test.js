import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { pickLanAddresses, startServer } from "../extensions/server.ts";

/** 用 node:http 发请求，可以伪造 Host / Origin 头（fetch 不允许）。 */
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

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

test("lan address picking prefers physical NICs and drops unusable ranges", () => {
  const picked = pickLanAddresses({
    Meta: [{ family: "IPv4", internal: false, address: "198.18.0.1" }],
    以太网: [{ family: "IPv4", internal: false, address: "10.17.204.246" }],
    "Loopback Pseudo-Interface 1": [
      { family: "IPv4", internal: true, address: "127.0.0.1" },
    ],
    "vEthernet (WSL)": [
      { family: "IPv4", internal: false, address: "172.22.160.1" },
    ],
    "Wi-Fi": [{ family: "IPv6", internal: false, address: "fe80::1" }],
    链路本地: [{ family: "IPv4", internal: false, address: "169.254.10.20" }],
  });
  // 实体网卡排在虚拟网卡前面；内部、IPv6、链路本地与 fake-IP 段全部丢弃
  assert.deepEqual(picked, [
    { name: "以太网", address: "10.17.204.246" },
    { name: "vEthernet (WSL)", address: "172.22.160.1" },
  ]);
  assert.deepEqual(pickLanAddresses({}), []);
  assert.deepEqual(pickLanAddresses(undefined), []);
});

test("wlan mode skips the Host check while loopback mode keeps it", async (t) => {
  const local = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
  });
  t.after(() => local.close());
  const localPort = local.connection.port;
  // 回环模式：Host 不匹配或来自其它 Origin 时一律拒绝
  assert.equal(
    await request(localPort, "/style.css", { Host: "evil.example" }),
    403,
  );
  assert.equal(
    await request(localPort, "/style.css", {
      Host: `127.0.0.1:${localPort}`,
      Origin: "http://evil.example",
    }),
    403,
  );
  assert.equal(local.connection.host, undefined);

  const lan = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
    connection: { host: "0.0.0.0" },
  });
  t.after(() => lan.close());
  const lanPort = lan.connection.port;
  // wlan 模式：不校验 Host / Origin（安全校验待补，见 AGENTS.md 待办）
  assert.equal(
    await request(lanPort, "/style.css", { Host: "evil.example" }),
    200,
  );
  assert.equal(
    await request(lanPort, "/style.css", {
      Host: `192.168.1.9:${lanPort}`,
      Origin: "http://192.168.1.9",
    }),
    200,
  );
  // 凭证仍然必验
  assert.equal(await request(lanPort, "/api/events"), 401);
  // 连接描述保留 host，/reload 进程内交接后仍是局域网模式
  assert.equal(lan.connection.host, "0.0.0.0");
  assert.match(lan.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/#[0-9a-f]{64}$/);
  assert.ok(Array.isArray(lan.addresses));
});

test("wlan rebind reuses the running port and token", async (t) => {
  const first = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
  });
  const { port, token } = first.connection;
  await first.close();
  const lan = await startServer({
    snapshot: () => initial,
    action: async () => ({}),
    connection: { port, token, host: "0.0.0.0" },
  });
  t.after(() => lan.close());
  // 端口与凭证沿用，已打开的页面不会失效（0.0.0.0 同时接受回环连接）
  assert.equal(lan.connection.port, port);
  assert.equal(lan.connection.token, token);
  assert.equal(await request(port, "/style.css"), 200);
  const client = await connect(`http://127.0.0.1:${port}/#${token}`);
  t.after(() => client.close());
  assert.equal((await client.next()).type, "snapshot");
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
