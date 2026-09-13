import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atomWeb from "../extensions/index.ts";
import {
  buildAskUserResult,
  createAskUserAdapter,
} from "../extensions/ask-user.ts";
import { startServer } from "../extensions/server.ts";

test("reload runs on command context even after ordinary event replaces context", async () => {
  const commands = new Map(),
    events = new Map();
  const pi = {
    getSessionName: () => "test",
    events: { on() {} },
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  atomWeb(pi);
  let reloads = 0;
  const ordinary = {
    cwd: "C:/test",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
    reload() {
      assert.fail("ordinary event context cannot reload");
    },
  };
  await events.get("session_start")({}, ordinary);
  await events.get("model_select")({}, ordinary);
  await commands.get("pi-atom-web-reload").handler("", {
    reload: async () => {
      reloads++;
    },
  });
  assert.equal(reloads, 1);
  await events.get("session_shutdown")();
});

test("reload mirrors notifications emitted while the replacement session starts", async () => {
  const seed = await startServer({ snapshot: () => ({}), action: () => ({}) });
  const { connection, url } = seed;
  await seed.close();
  const directory = await mkdtemp(join(tmpdir(), "pi-atom-web-notify-"));
  const events = new Map();
  const pi = {
    getSessionName: () => "test",
    getCommands: () => [],
    events: { on() {} },
    on: (name, handler) => events.set(name, handler),
    registerCommand() {},
  };
  const tuiNotifications = [];
  const ctx = {
    cwd: directory,
    ui: { notify: (text) => tuiNotifications.push(text) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "reload-notify-session",
      getBranch: () => [],
    },
  };
  atomWeb(pi);
  globalThis[Symbol.for("pi-atom-web.reload-handoff")] = connection;
  try {
    const starting = events.get("session_start")({}, ctx);
    ctx.ui.notify("调度器在重载期间启动");
    await starting;
    const response = await fetch(new URL("/api/events", url), {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(value);
    const event = JSON.parse(frame.slice(6, frame.indexOf("\n\n")));
    assert.deepEqual(
      event.snapshot.messages.map((message) => message.content),
      ["调度器在重载期间启动", "pi-atom-web 已随 /reload 恢复"],
    );
    assert.deepEqual(tuiNotifications, [
      "调度器在重载期间启动",
      "pi-atom-web 已随 /reload 恢复",
    ]);
  } finally {
    await events.get("session_shutdown")();
    delete globalThis[Symbol.for("pi-atom-web.reload-handoff")];
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi answer preserves ordinary selections and appends custom text", () => {
  const questions = [
    {
      question: "选择功能",
      header: "功能",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    },
  ];
  assert.deepEqual(
    buildAskUserResult(questions, [
      {
        kind: "multi",
        options: [1, 0],
        custom: true,
        text: "C",
        notes: "备注",
      },
    ]),
    {
      answers: [
        {
          questionIndex: 0,
          question: "选择功能",
          kind: "multi",
          answer: null,
          selected: ["A", "B", "C"],
          notes: "备注",
        },
      ],
      cancelled: false,
    },
  );
  assert.throws(
    () => buildAskUserResult(questions, [{ kind: "multi", options: [0, 0] }]),
    /多选/,
  );
});

test("ask adapter does not claim unrelated or ambiguous custom UI factories", () => {
  const adapter = createAskUserAdapter();
  const questions = [
    {
      header: "测试",
      question: "选哪项",
      options: [{ label: "A", description: "一个" }],
    },
  ];
  adapter.start({
    toolName: "ask_user_question",
    toolCallId: "one",
    args: { questions },
  });
  adapter.prompt({ questions });
  assert.equal(
    adapter.take(() => "unrelated"),
    undefined,
  );
  const selected = adapter.take(() => "QuestionnaireSession");
  assert.equal(selected.toolCallId, "one");
  adapter.clear();
  for (const toolCallId of ["one", "two"])
    adapter.start({
      toolName: "ask_user_question",
      toolCallId,
      args: { questions },
    });
  adapter.prompt({ questions });
  assert.equal(
    adapter.take(() => "QuestionnaireSession"),
    undefined,
  );
});

test("real bridge updates statistics on same-session branch navigation and rejects stale actions", async () => {
  const seed = await startServer({ snapshot: () => ({}), action: () => ({}) });
  const { connection, url } = seed;
  await seed.close();
  const events = new Map(),
    commands = new Map(),
    sent = [];
  let idle = true;
  let branch = [
    {
      id: "entry-one",
      type: "message",
      timestamp: 1000,
      message: { role: "user", content: "first" },
    },
    {
      id: "entry-custom",
      type: "custom",
      timestamp: "2026-09-13T10:00:00.000Z",
      customType: "example-status",
      data: { active: true, count: 2 },
    },
  ];
  const pi = {
    getSessionName: () => "test",
    getCommands: () => [],
    events: { on() {} },
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (...args) => sent.push(args),
  };
  const ctx = {
    cwd: "C:/fixture",
    ui: { notify() {} },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "bridge-session",
      getBranch: () => branch,
    },
  };
  atomWeb(pi);
  globalThis[Symbol.for("pi-atom-web.reload-handoff")] = connection;
  let reader;
  try {
    await events.get("session_start")({}, ctx);
    const response = await fetch(new URL("/api/events", url), {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async () => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf("\n\n"),
        frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(frame.slice(6));
    };
    const first = await nextEvent();
    assert.equal(first.snapshot.stats.rounds, 1);
    assert.deepEqual(first.snapshot.messages.find((message) => message.role === "customEntry"), {
      id: "bridge-session:branch:entry-custom",
      role: "customEntry",
      customType: "example-status",
      data: { active: true, count: 2 },
      timestamp: "2026-09-13T10:00:00.000Z",
    });
    const submitted = await fetch(new URL("/api/action", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "send",
        sessionId: "bridge-session",
        text: "show immediately",
        mode: "followUp",
      }),
    });
    assert.equal(submitted.status, 200);
    let pendingPrompt;
    do {
      pendingPrompt = await nextEvent();
    } while (
      pendingPrompt.patch?.pendingUserMessages?.[0]?.content !==
      "show immediately"
    );
    assert.equal(
      pendingPrompt.patch.pendingUserMessages[0].content,
      "show immediately",
    );
    assert.equal(typeof pendingPrompt.patch.responseWaitStartedAt, "number");
    branch.push({
      id: "submitted-entry",
      type: "message",
      timestamp: 1500,
      message: {
        role: "user",
        content: [{ type: "text", text: "show immediately" }],
      },
    });
    await events.get("message_start")(
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "show immediately" }],
        },
      },
      ctx,
    );
    let reconciled;
    do {
      reconciled = await nextEvent();
    } while (!reconciled.patch?.messages);
    assert.deepEqual(reconciled.patch.pendingUserMessages, []);
    assert.equal(
      reconciled.patch.messages.filter(
        (message) =>
          message.role === "user" &&
          message.content?.[0]?.text === "show immediately",
      ).length,
      1,
    );
    await events.get("message_start")(
      { message: { role: "assistant", content: [] } },
      ctx,
    );
    let waitCleared;
    do {
      waitCleared = await nextEvent();
    } while (waitCleared.patch?.responseWaitStartedAt !== null);
    idle = false;
    const queued = await fetch(new URL("/api/action", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "send",
        sessionId: "bridge-session",
        text: "queued prompt",
        mode: "followUp",
      }),
    });
    assert.equal(queued.status, 200);
    let queuedPatch;
    do {
      queuedPatch = await nextEvent();
    } while (
      queuedPatch.patch?.pendingUserMessages?.[0]?.content !== "queued prompt"
    );
    assert.equal(queuedPatch.patch.responseWaitStartedAt, undefined);
    await events.get("message_update")(
      { message: { role: "assistant", content: "old response" } },
      ctx,
    );
    await events.get("message_start")(
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "queued prompt" }],
        },
      },
      ctx,
    );
    let queuedStarted;
    do {
      queuedStarted = await nextEvent();
    } while (typeof queuedStarted.patch?.responseWaitStartedAt !== "number");
    assert.equal(typeof queuedStarted.patch.responseWaitStartedAt, "number");
    await events.get("agent_end")({}, ctx);
    let failedSubmissionCleared;
    do {
      failedSubmissionCleared = await nextEvent();
    } while (
      failedSubmissionCleared.patch?.responseWaitStartedAt !== null ||
      !Array.isArray(failedSubmissionCleared.patch?.pendingUserMessages)
    );
    assert.deepEqual(failedSubmissionCleared.patch.pendingUserMessages, []);
    branch = [
      {
        id: "entry-two",
        type: "message",
        timestamp: 2000,
        message: {
          role: "assistant",
          content: "other branch",
          usage: { input: 10, output: 20, cost: { total: 0.4 } },
        },
      },
    ];
    await events.get("session_tree")({}, ctx);
    let changed;
    do {
      changed = await nextEvent();
    } while (changed.type !== "patch" || !changed.patch.stats);
    assert.equal(changed.patch.stats.rounds, 0);
    assert.equal(changed.patch.stats.usage.total, 30);
    assert.equal(changed.patch.stats.usage.cost, 0.4);
    const finalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "final thought" },
        { type: "text", text: "final answer" },
      ],
    };
    await events.get("message_start")({ message: finalMessage }, ctx);
    await events.get("message_update")({ message: finalMessage }, ctx);
    const live = await nextEvent();
    assert.equal(live.patch.liveMessage.content[1].text, "final answer");
    const liveId = live.patch.liveMessage.id;
    // pi dispatches message_end before it appends the message to SessionManager.
    await events.get("message_end")({ message: finalMessage }, ctx);
    branch.push({
      id: "final-entry",
      type: "message",
      timestamp: 3000,
      message: finalMessage,
    });
    await events.get("agent_end")({}, ctx);
    const finished = await Promise.race([
      nextEvent(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("final history update missing")),
          1000,
        ),
      ),
    ]);
    assert.equal(
      finished.patch.messages?.at(-1).content[1].text,
      "final answer",
    );
    assert.equal(finished.patch.messages.at(-1).liveId, liveId);
    assert.equal(finished.patch.liveMessage, null);
    const stale = await fetch(new URL("/api/action", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "send",
        sessionId: "stale",
        text: "never send",
        mode: "followUp",
      }),
    });
    assert.equal(stale.status, 400);
    assert.equal(sent.length, 2);
    assert.equal(sent[0][0], "show immediately");
    assert.equal(sent[1][0], "queued prompt");
  } finally {
    await reader?.cancel();
    await events.get("session_shutdown")();
    delete globalThis[Symbol.for("pi-atom-web.reload-handoff")];
  }
});
