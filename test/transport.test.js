import test from "node:test";
import assert from "node:assert/strict";
import { createEventStream } from "../web/api/event-stream.js";

const snapshot = {
  schemaVersion: 1,
  type: "snapshot",
  streamId: "stream",
  sequence: 0,
  sessionId: "session",
  snapshot: {
    schemaVersion: 1,
    sessionId: "session",
    instanceId: "instance",
    name: "test",
    cwd: "C:/test",
    messages: [],
    liveMessage: null,
    tools: [],
    requests: [],
  },
};
const encode = (value) =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
async function until(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1500)
      throw new Error("transport condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test("invalid sequence releases stream and stopping prevents reconnect", async () => {
  let source,
    cancels = 0,
    requests = 0;
  const events = [],
    errors = [];
  const transport = createEventStream({
    token: "a".repeat(64),
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    fetchImpl: async () => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            source = controller;
          },
          cancel() {
            cancels++;
          },
        }),
      );
    },
  });
  try {
    await until(() => source);
    source.enqueue(encode(snapshot));
    await until(() => events.length === 1);
    source.enqueue(
      encode({
        schemaVersion: 1,
        type: "patch",
        streamId: "stream",
        sessionId: "session",
        sequence: 2,
        patch: { busy: true },
      }),
    );
    await until(() => errors.length === 1 && cancels === 1);
    transport.stop();
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(requests, 1);
    assert.equal(events.length, 1);
  } finally {
    transport.stop();
  }
});
test("a response resolved after stop cannot update connection state or session", async () => {
  let respond,
    cancelled = false;
  const events = [],
    states = [];
  const transport = createEventStream({
    token: "a".repeat(64),
    onEvent: (value) => events.push(value),
    onState: (value) => states.push(value),
    fetchImpl: () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  });
  transport.stop();
  respond(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encode(snapshot));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await until(() => cancelled);
  assert.deepEqual(events, []);
  assert.deepEqual(states, ["connecting"]);
});
test("401 is a terminal authorization failure", async () => {
  let requests = 0;
  const states = [];
  const transport = createEventStream({
    token: "a".repeat(64),
    onEvent() {
      assert.fail("unauthorized payload must not be delivered");
    },
    onState: (value) => states.push(value),
    fetchImpl: async () => {
      requests++;
      return new Response('{"error":"expired"}', { status: 401 });
    },
  });
  try {
    await until(() => states.includes("failed"));
    assert.equal(requests, 1);
  } finally {
    transport.stop();
  }
});

test("a silent half-open stream is detected by the idle watchdog and resynced", async () => {
  let source,
    requests = 0;
  const states = [];
  const transport = createEventStream({
    token: "a".repeat(64),
    idleLimitMs: 80,
    onEvent: () => {},
    onState: (value) => states.push(value),
    onError: () => {},
    fetchImpl: async (_path, { signal } = {}) => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            source = controller;
            // 真实 fetch 会把 AbortSignal 接在流上；假实现也要接，否则 abort() 是空操作。
            signal?.addEventListener?.("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              controller.error(error);
            });
          },
        }),
      );
    },
  });
  try {
    await until(() => source);
    const first = source;
    first.enqueue(encode(snapshot));
    await until(() => states.includes("connected"));
    // 之后一个字节都不再到达：既不 resolve 也不 reject（机器休眠后的典型形态）。
    // 服务端每 15s 会写 `: heartbeat`，所以沉默本身就说明连接已死。
    await until(() => requests === 2);
    await until(() => source !== first);
    assert.equal(states.filter((value) => value === "reconnecting").length, 1);
  } finally {
    transport.stop();
  }
});

test("resume() resyncs only after a long silence, never on a fresh stream", async () => {
  let source,
    requests = 0;
  const make = (resumeStaleMs) =>
    createEventStream({
      token: "a".repeat(64),
      idleLimitMs: 100_000, // 本用例只验 resume 分支，不让看门狗抢跑
      resumeStaleMs,
      onEvent: () => {},
      onState: () => {},
      onError: () => {},
      fetchImpl: async (_path, { signal } = {}) => {
        requests++;
        return new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
              signal?.addEventListener?.("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                controller.error(error);
              });
            },
          }),
        );
      },
    });

  const fresh = make(60_000);
  await until(() => source);
  source.enqueue(encode(snapshot));
  await until(() => requests === 1);
  fresh.resume();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 1, "刚收到过字节时 resume 不该重连");
  fresh.stop();

  source = undefined;
  const stale = make(0); // 沉默阈值为 0：任何 resume 都应当立刻重连
  await until(() => source);
  source.enqueue(encode(snapshot));
  await until(() => requests === 2);
  stale.resume();
  await until(() => requests === 3);
  stale.stop();
});
