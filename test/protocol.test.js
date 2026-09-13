import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAction,
  validateServerEvent,
  validateSnapshot,
} from "../shared/protocol.js";

const snapshot = {
  schemaVersion: 1,
  sessionId: "session-a",
  instanceId: "instance-a",
  name: "测试会话",
  cwd: "C:/workspace",
  messages: [],
  liveMessage: null,
  tools: [],
  requests: [],
};

test("Pi custom and summary messages do not invalidate the event stream", () => {
  for (const message of [
    {
      id: "custom",
      role: "custom",
      customType: "extension",
      content: "notice",
      display: true,
    },
    { id: "branch", role: "branchSummary", summary: "branch summary" },
    { id: "compact", role: "compactionSummary", summary: "compact summary" },
  ])
    assert.doesNotThrow(() =>
      validateSnapshot({ ...snapshot, liveMessage: message }),
    );
});

test("protocol accepts generic appendEntry records and rejects unsafe shapes", () => {
  const entry = {
    id: "entry-1",
    role: "customEntry",
    customType: "plugin:status",
    data: { active: true, count: 2 },
    collapsedText: "[plugin] 摘要",
    expandedText: "[plugin] 完整正文",
    timestamp: "2026-09-13T10:00:00.000Z",
  };
  assert.equal(validateSnapshot({ ...snapshot, messages: [entry] }).messages[0], entry);
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      messages: [{ ...entry, customType: "" }],
    }),
  );
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      messages: [{ ...entry, data: { invalid: undefined } }],
    }),
  );
});

test("protocol validators return valid input unchanged", () => {
  const action = {
    type: "send",
    sessionId: "session-a",
    text: "hello",
    mode: "followUp",
  };
  const event = {
    schemaVersion: 1,
    type: "snapshot",
    streamId: "stream-a",
    sequence: 0,
    sessionId: "session-a",
    snapshot,
  };
  assert.equal(validateAction(action), action);
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.equal(validateServerEvent(event), event);
});

test("protocol accepts bounded Web-only timing and disclosure state", () => {
  const action = {
    type: "save_ui_state",
    sessionId: "session-a",
    thinkingTimings: { thought: { startedAt: 10, durationMs: 20 } },
    disclosures: { thought: true, "tool-call": false },
  };
  assert.equal(validateAction(action), action);
  assert.equal(
    validateSnapshot({
      ...snapshot,
      thinkingTimings: action.thinkingTimings,
      disclosures: action.disclosures,
    }).thinkingTimings,
    action.thinkingTimings,
  );
  assert.throws(() =>
    validateAction({ ...action, disclosures: { thought: "open" } }),
  );
});

test("snapshot accepts Pi bashExecution entries without content", () => {
  const value = {
    ...snapshot,
    messages: [
      {
        id: "bash-1",
        role: "bashExecution",
        command: "dir",
        output: "file.txt",
      },
    ],
  };
  assert.equal(validateSnapshot(value), value);
});

test("protocol validators reject malformed actions and events", () => {
  assert.throws(() =>
    validateAction({
      type: "send",
      sessionId: "session-a",
      text: "",
      mode: "followUp",
    }),
  );
  assert.throws(() =>
    validateAction({
      type: "select_model",
      sessionId: "session-a",
      provider: "",
      modelId: "x",
    }),
  );
  assert.throws(() =>
    validateAction({ type: "abort", sessionId: "session-a", extra: true }),
  );
  assert.throws(() =>
    validateAction({
      type: "dialog_response",
      sessionId: "session-a",
      id: "dialog-a",
      value: { bad: undefined },
    }),
  );
  assert.throws(() =>
    validateSnapshot({ ...snapshot, messages: "not-an-array" }),
  );
  assert.throws(() => validateSnapshot({ ...snapshot, busy: "yes" }));
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      messages: [{ id: "m1", role: "unknown", content: "bad" }],
    }),
  );
  assert.throws(() =>
    validateServerEvent({
      schemaVersion: 1,
      type: "patch",
      streamId: "stream-a",
      sequence: 1,
      sessionId: "session-a",
      patch: null,
    }),
  );
  assert.throws(() =>
    validateServerEvent({
      schemaVersion: 1,
      type: "patch",
      streamId: "stream-a",
      sequence: 1,
      sessionId: "session-a",
      patch: { busy: "yes" },
    }),
  );
  assert.throws(() =>
    validateServerEvent({
      schemaVersion: 1,
      type: "patch",
      streamId: "stream-a",
      sequence: 1,
      sessionId: "session-a",
      patch: { unexpected: true },
    }),
  );
  assert.throws(() =>
    validateServerEvent({
      schemaVersion: 1,
      type: "snapshot",
      streamId: "stream-a",
      sequence: 2,
      sessionId: "session-a",
      snapshot,
      patch: {},
    }),
  );
});
