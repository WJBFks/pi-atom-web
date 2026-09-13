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
