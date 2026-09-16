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

test("send accepts bounded image blocks and image-only prompts", () => {
  const action = {
    type: "send",
    sessionId: "session-a",
    text: "",
    images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
    mode: "followUp",
  };
  assert.equal(validateAction(action), action);
  assert.throws(() => validateAction({ ...action, images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }));
  assert.throws(() => validateAction({ ...action, images: [] }));
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

test("protocol validates package-scoped questionnaire requests", () => {
  const request = {
    id: "ask-1",
    sessionId: "session-a",
    packageId: "@juicesharp/rpiv-ask-user-question",
    kind: "ask_user_question",
    toolCallId: "call-1",
    title: "自定义扩展界面",
    lines: [],
    questions: [{
      header: "方案",
      question: "选择方案？",
      options: [
        { label: "A", description: "甲", preview: "**A**" },
        { label: "B", description: "乙" },
      ],
    }],
  };
  assert.equal(
    validateSnapshot({ ...snapshot, requests: [request] }).requests[0],
    request,
  );
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      requests: [{ ...request, sessionId: undefined }],
    }),
  );
  // 字段级 schema 属于拥有该请求的包模块（extensions/packages/*），协议层只保证
  // 通用有界：JSON 可序列化 + 总长度上限，畸形问卷由包模块拒绝认领。
  assert.equal(
    validateSnapshot({
      ...snapshot,
      requests: [{
        ...request,
        questions: [{ ...request.questions[0], options: [] }],
      }],
    }).requests[0].questions[0].options.length,
    0,
  );
  assert.throws(() =>
    validateSnapshot({
      ...snapshot,
      requests: [{ ...request, payload: "x".repeat(300 * 1024) }],
    }),
  );
  assert.throws(() => validateSnapshot({ ...snapshot, requests: [{ ...request, bad: () => {} }] }));
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

test("protocol accepts paged history prepends and the more_history cursor", () => {
  // 向前补的更早历史 + 是否已经到最早一条
  const snapshotWithPage = {
    ...snapshot,
    historyComplete: false,
    prependMessages: [
      { id: "older-1", role: "user", content: "更早的问题" },
      { id: "older-2", role: "assistant", content: "更早的回答" },
    ],
  };
  assert.equal(validateSnapshot(snapshotWithPage), snapshotWithPage);
  assert.equal(
    validateServerEvent({
      schemaVersion: 1,
      type: "patch",
      streamId: "stream-a",
      sequence: 2,
      sessionId: "session-a",
      patch: { prependMessages: snapshotWithPage.prependMessages, historyComplete: true },
    }).patch.historyComplete,
    true,
  );
  assert.throws(() => validateSnapshot({ ...snapshot, prependMessages: {} }));
  assert.throws(() => validateSnapshot({ ...snapshot, prependMessages: [1] }));
  assert.throws(() => validateSnapshot({ ...snapshot, historyComplete: "yes" }));
  assert.throws(() =>
    validateSnapshot({ ...snapshot, prependMessages: new Array(2001).fill({ role: "user" }) }),
  );

  // more_history 动作必须带游标，且不接受多余字段
  const action = {
    type: "more_history",
    sessionId: "session-a",
    cursor: "session-a:branch:entry-12",
  };
  assert.equal(validateAction(action), action);
  assert.throws(() => validateAction({ ...action, cursor: undefined }));
  assert.throws(() => validateAction({ ...action, limit: 10 }));
  assert.throws(() => validateAction({ ...action, cursor: 12 }));
});

test("protocol validates prompt queue snapshots, additions and guarded deletion", () => {
  const promptQueue = {
    revision: 4,
    count: 2,
    steering: [{ id: "steer:0:abc", kind: "steer", index: 0, text: "现在修正" }],
    followUp: [{ id: "followUp:0:def", kind: "followUp", index: 0, text: "然后总结" }],
  };
  assert.equal(validateSnapshot({ ...snapshot, promptQueue }).promptQueue, promptQueue);
  for (const kind of ["steer", "followUp"]) {
    const action = { type: "queue_add", sessionId: "session-a", kind, text: "排队内容" };
    assert.equal(validateAction(action), action);
  }
  const remove = {
    type: "queue_remove",
    sessionId: "session-a",
    id: "steer:0:abc",
    revision: 4,
  };
  assert.equal(validateAction(remove), remove);
  const update = {
    type: "queue_update_item",
    sessionId: "session-a",
    id: promptQueue.followUp[0].id,
    revision: 2,
    kind: "steer",
    text: "转为引导并改写",
  };
  assert.equal(validateAction(update), update);
  assert.throws(() => validateAction({ ...remove, revision: -1 }));
  assert.throws(() => validateAction({ ...remove, id: "" }));
  assert.throws(() => validateSnapshot({ ...snapshot, promptQueue: { ...promptQueue, count: 3 } }));
  assert.throws(() => validateAction({ ...update, kind: "later" }));
  assert.throws(() => validateAction({ ...update, text: "" }));
});
