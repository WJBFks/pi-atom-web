import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromptQueueBridge,
  installPromptQueueRuntime,
  promptQueueSnapshot,
} from "../extensions/prompt-queue.ts";

class FakeSession {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.steering = [];
    this.followUps = [];
    this.listeners = new Set();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emitQueue() {
    const event = {
      type: "queue_update",
      steering: [...this.steering],
      followUp: [...this.followUps],
    };
    for (const listener of this.listeners) listener(event);
  }
  getSteeringMessages() { return this.steering; }
  getFollowUpMessages() { return this.followUps; }
  async steer(text) { this.steering.push(text); this.emitQueue(); }
  async followUpMessage(text) { this.followUps.push(text); this.emitQueue(); }
  async followUp(text) { return this.followUpMessage(text); }
  clearQueue() {
    const removed = { steering: [...this.steering], followUp: [...this.followUps] };
    this.steering = [];
    this.followUps = [];
    this.emitQueue();
    return removed;
  }
}

test("prompt queue snapshot exposes both queues, stable item metadata and total count", () => {
  const snapshot = promptQueueSnapshot(["立即修正"], ["完成后总结", "再跑测试"], 7);
  assert.equal(snapshot.revision, 7);
  assert.equal(snapshot.count, 3);
  assert.deepEqual(snapshot.steering[0], {
    id: snapshot.steering[0].id,
    kind: "steer",
    index: 0,
    text: "立即修正",
  });
  assert.equal(snapshot.followUp[1].kind, "followUp");
  assert.equal(snapshot.followUp[1].index, 1);
});

test("queue bridge listens for updates, adds messages and deletes one with full return data", async () => {
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new FakeSession(sessionManager);
  bridge.attach(session);
  const updates = [];
  const stop = bridge.listen(sessionManager, (queue) => updates.push(queue));

  await bridge.add(sessionManager, "steer", "先检查日志");
  await bridge.add(sessionManager, "followUp", "完成后写总结");
  const before = bridge.snapshot(sessionManager);
  const target = before.steering[0];
  const result = await bridge.remove(sessionManager, {
    id: target.id,
    revision: before.revision,
  });

  assert.deepEqual(result.removed, target);
  assert.equal(result.queue.count, 1);
  assert.deepEqual(result.queue.steering, []);
  assert.equal(result.queue.followUp[0].text, "完成后写总结");
  assert.ok(updates.length >= 3);
  stop();
});

test("queue bridge rejects stale single-item deletion instead of deleting another prompt", async () => {
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new FakeSession(sessionManager);
  session.followUps = ["A", "B"];
  bridge.attach(session);
  const stale = bridge.snapshot(sessionManager);
  await bridge.add(sessionManager, "followUp", "C");
  await assert.rejects(
    bridge.remove(sessionManager, {
      id: stale.followUp[0].id,
      revision: stale.revision,
    }),
    /队列已变化/,
  );
  assert.deepEqual(session.followUps, ["A", "B", "C"]);
});

test("queue bridge edits text and moves a queued prompt into steering", async () => {
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new FakeSession(sessionManager);
  session.steering = ["已有引导"];
  session.followUps = ["待修改", "保持排队"];
  bridge.attach(session);
  const before = bridge.snapshot(sessionManager);
  const original = before.followUp[0];

  const result = await bridge.update(sessionManager, {
    id: original.id,
    revision: before.revision,
    kind: "steer",
    text: "修改后立即引导",
  });

  assert.deepEqual(result.previous, original);
  assert.equal(result.updated.kind, "steer");
  assert.equal(result.updated.text, "修改后立即引导");
  assert.deepEqual(session.steering, ["已有引导", "修改后立即引导"]);
  assert.deepEqual(session.followUps, ["保持排队"]);
  assert.deepEqual(result.queue.steering.map((item) => item.text), [
    "已有引导",
    "修改后立即引导",
  ]);
});

test("queue bridge rejects stale edits without rebuilding the queue", async () => {
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new FakeSession(sessionManager);
  session.followUps = ["A"];
  bridge.attach(session);
  const before = bridge.snapshot(sessionManager);
  await bridge.add(sessionManager, "followUp", "B");

  await assert.rejects(
    bridge.update(sessionManager, {
      id: before.followUp[0].id,
      revision: before.revision,
      kind: "steer",
      text: "改写",
    }),
    /队列已变化/,
  );
  assert.deepEqual(session.steering, []);
  assert.deepEqual(session.followUps, ["A", "B"]);
});

test("failed queue rebuild still publishes the current Pi queue", async () => {
  class FailingSession extends FakeSession {
    async followUp(text) {
      if (text === "C") throw new Error("requeue failed");
      return super.followUp(text);
    }
  }
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new FailingSession(sessionManager);
  session.followUps = ["A", "B", "C"];
  bridge.attach(session);
  const updates = [];
  bridge.listen(sessionManager, (queue) => updates.push(queue));
  const before = bridge.snapshot(sessionManager);

  await assert.rejects(
    bridge.remove(sessionManager, {
      id: before.followUp[0].id,
      revision: before.revision,
    }),
    /requeue failed/,
  );
  assert.deepEqual(session.followUps, ["B"]);
  assert.deepEqual(updates.at(-1).followUp.map((item) => item.text), ["B"]);
});

test("runtime installer captures sessions when Pi binds extension core", () => {
  class RuntimeSession extends FakeSession {
    _bindExtensionCore(runner) { return runner; }
  }
  const bridge = installPromptQueueRuntime(RuntimeSession);
  const sessionManager = {};
  const session = new RuntimeSession(sessionManager);
  session.steering = ["captured"];
  assert.equal(session._bindExtensionCore("runner"), "runner");
  assert.equal(bridge.snapshot(sessionManager).steering[0].text, "captured");
});

test("queue bridge waits for prompt preflight so a second submit becomes follow-up", async () => {
  class PromptSession extends FakeSession {
    active = false;
    started = [];
    async prompt(text, options) {
      if (this.active) {
        if (options.streamingBehavior === "followUp") {
          this.followUps.push(text);
          this.emitQueue();
          options.preflightResult?.(true);
          return;
        }
        throw new Error("Agent is already processing a prompt");
      }
      this.active = true;
      this.started.push(text);
      options.preflightResult?.(true);
    }
  }
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  const session = new PromptSession(sessionManager);
  bridge.attach(session);

  await bridge.submit(sessionManager, "第一条", { mode: "followUp" });
  await bridge.submit(sessionManager, "第二条", { mode: "followUp" });

  assert.deepEqual(session.started, ["第一条"]);
  assert.deepEqual(session.followUps, ["第二条"]);
});

test("queue bridge returns prompt preflight failures to the action caller", async () => {
  class RejectedPromptSession extends FakeSession {
    async prompt(_text, options) {
      options.preflightResult?.(false);
      throw new Error("preflight rejected");
    }
  }
  const bridge = createPromptQueueBridge();
  const sessionManager = {};
  bridge.attach(new RejectedPromptSession(sessionManager));

  await assert.rejects(
    bridge.submit(sessionManager, "失败", { mode: "followUp" }),
    /preflight rejected/,
  );
});
