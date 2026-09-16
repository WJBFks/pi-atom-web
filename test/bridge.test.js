import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atomWeb from "../extensions/index.ts";
import {
  buildAskUserResult,
  createAskUserAdapter,
} from "../extensions/packages/@juicesharp/rpiv-ask-user-question/index.ts";
import { createPackageCompatibilityRegistry } from "../extensions/packages/registry.ts";
import { startServer } from "../extensions/server.ts";
import { bridgeDialogs } from "../extensions/dialogs.ts";

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

test("multi answers carry selected labels while free text stays a custom answer", () => {
  const questions = [
    {
      question: "选择功能",
      header: "功能",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    },
  ];
  // selected 按选项顺序（不是点击顺序）汇总，与宿主 state-reducer 一致
  assert.deepEqual(
    buildAskUserResult(questions, [
      {
        kind: "multi",
        options: [1, 0],
        notes: "备注",
      },
    ], false, "全局备注"),
    {
      answers: [
        {
          questionIndex: 0,
          question: "选择功能",
          kind: "multi",
          answer: null,
          selected: ["A", "B"],
          notes: "备注",
        },
      ],
      cancelled: false,
      globalNote: "全局备注",
    },
  );
  // 自由回答是独立的 custom 答案，不再并进 selected
  assert.deepEqual(
    buildAskUserResult(questions, [{ kind: "custom", text: "C" }]).answers,
    [{ questionIndex: 0, question: "选择功能", kind: "custom", answer: "C" }],
  );
  assert.throws(
    () => buildAskUserResult(questions, [{ kind: "multi", options: [0, 0] }]),
    /多选/,
  );
  // 单选不接受多选形状，多选不接受单选形状
  assert.throws(
    () => buildAskUserResult(questions, [{ kind: "option", option: 0 }]),
    /单选/,
  );
  const single = [{ question: "单选", header: "单选", options: [{ label: "A" }, { label: "B" }] }];
  assert.throws(
    () => buildAskUserResult(single, [{ kind: "multi", options: [0] }]),
    /多选/,
  );
});

test("clearing every multi checkbox contributes no answer, matching the host", () => {
  const questions = [
    {
      question: "选择功能",
      header: "功能",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    },
  ];
  // 宿主对 selected 为空的答案是直接删除（视为未答），而不是空多选答案
  assert.deepEqual(buildAskUserResult(questions, [{ kind: "multi", options: [] }]).answers, []);
  assert.deepEqual(buildAskUserResult(questions, [{ kind: "unanswered" }]).answers, []);
});

test("package compatibility keeps claiming every consecutive ask in one session", async () => {
  // 回归：registry 曾把历史 prompt 事件在每次加载/replay 时重复注入适配器，
  // 使 ready 出现多个候选而被歧义保护拒绝，第二个问卷静默退回通用终端。
  const listeners = new Map();
  const registry = createPackageCompatibilityRegistry({
    events: { on: (name, handler) => listeners.set(name, handler) },
  });
  const questions = label => [{
    header: label,
    question: `问题 ${label}`,
    options: [
      { label: "A", description: "甲" },
      { label: "B", description: "乙" },
    ],
  }];
  const eventFor = qs => qs.map(q => ({
    ...q,
    multiSelect: false,
    options: q.options.map(o => ({ ...o, hasPreview: false })),
  }));
  const factory = () => {
    const Session = class {};
    const sessionRef = { current: null };
    return function QuestionnaireSessionFactory(tui, theme, keybindings, done) {
      const session = new Session({ tui, theme, keybindings, done });
      sessionRef.current = session;
      return session.component;
    };
  };

  for (const [toolCallId, label] of [["ask-1", "一"], ["ask-2", "二"], ["ask-3", "三"]]) {
    const qs = questions(label);
    registry.start({ toolName: "ask_user_question", toolCallId, args: { questions: qs } });
    listeners.get("rpiv:ask-user:prompt")({ questions: eventFor(qs) });
    const claim = await registry.takeCustom(factory());
    assert.equal(claim?.toolCallId, toolCallId, `第 ${label} 次提问应被认领`);
    registry.end(toolCallId);
  }

  // 事件先于适配器加载到达时，缓冲的候选仍需在激活后补投。
  const lateQuestions = questions("迟到");
  const late = createPackageCompatibilityRegistry({
    events: { on: (name, handler) => listeners.set(`late:${name}`, handler) },
  });
  listeners.get("late:rpiv:ask-user:prompt")({ questions: eventFor(lateQuestions) });
  late.start({ toolName: "ask_user_question", toolCallId: "ask-late", args: { questions: lateQuestions } });
  assert.equal(
    (await late.takeCustom(factory()))?.toolCallId,
    "ask-late",
  );
});

test("package compatibility stays inactive until its tool is observed", async () => {
  const listeners = new Map();
  const registry = createPackageCompatibilityRegistry({
    events: { on: (name, handler) => listeners.set(name, handler) },
  });
  assert.equal(registry.activePackageIds().length, 0);
  registry.start({ toolName: "read", toolCallId: "read-1", args: {} });
  assert.equal(registry.activePackageIds().length, 0);
  const questions = [{ header: "选择", question: "选择？", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }] }];
  registry.start({ toolName: "ask_user_question", toolCallId: "ask-1", args: { questions } });
  listeners.get("rpiv:ask-user:prompt")({ questions });
  const claim = await registry.takeCustom(() => "QuestionnaireSession");
  assert.equal(claim.packageId, "@juicesharp/rpiv-ask-user-question");
  assert.equal(claim.request.kind, "ask_user_question");
});

test("ask adapter does not claim unrelated or ambiguous custom UI factories", () => {
  const adapter = createAskUserAdapter();
  const questions = [
    {
      header: "测试",
      question: "选哪项",
      options: [{ label: "A", description: "一个" }, { label: "B", description: "两个" }],
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

test("ask adapter ignores malformed questionnaires and keeps the generic fallback", () => {
  const adapter = createAskUserAdapter();
  const question = {
    header: "选择",
    question: "选择？",
    options: [
      { label: "A", description: "一个" },
      { label: "B", description: "两个" },
    ],
  };
  const malformed = [
    [],
    Array.from({ length: 5 }, () => question),
    [{ ...question, header: "x".repeat(17) }],
    [{ ...question, options: [{ label: "A", description: "一个" }] }],
    [{ ...question, options: [{ label: "", description: "空标签" }, { label: "B", description: "两个" }] }],
    "questions",
  ];
  for (const questions of malformed) {
    adapter.clear();
    adapter.start({ toolName: "ask_user_question", toolCallId: "bad", args: { questions } });
    adapter.prompt({ questions });
    assert.equal(
      adapter.take(() => "QuestionnaireSession"),
      undefined,
      `不应认领畸形问卷：${JSON.stringify(questions).slice(0, 60)}`,
    );
  }
  // 合法问卷仍然正常认领
  adapter.clear();
  adapter.start({ toolName: "ask_user_question", toolCallId: "ok", args: { questions: [question] } });
  adapter.prompt({
    questions: [{
      ...question,
      options: question.options.map(option => ({ ...option, hasPreview: false })),
    }],
  });
  assert.equal(adapter.take(() => "QuestionnaireSession")?.toolCallId, "ok");
});

test("ask adapter recognizes the rpiv 2.9 QuestionnaireSession factory shape", () => {
  const adapter = createAskUserAdapter();
  const questions = [
    {
      header: "布局",
      question: "对话区现在的紧凑程度满意吗？",
      options: [
        { label: "满意", description: "保持当前布局" },
        { label: "再紧凑一些", description: "继续缩小间距" },
      ],
    },
  ];
  adapter.start({
    toolName: "ask_user_question",
    toolCallId: "rpiv-2.9",
    args: { questions },
  });
  adapter.prompt({ questions });

  const Session = class {};
  const sessionRef = { current: null };
  const factory = (tui, theme, keybindings, done) => {
    const session = new Session({ tui, theme, keybindings, done });
    sessionRef.current = session;
    return session.component;
  };

  const selected = adapter.take(factory);
  assert.equal(selected?.packageId, "@juicesharp/rpiv-ask-user-question");
  assert.equal(selected?.toolCallId, "rpiv-2.9");
});

test("dialog bridge returns the package result contract including global notes", async () => {
  const adapter = createAskUserAdapter();
  const questions = [{
    header: "方案",
    question: "选择方案？",
    options: [
      { label: "A", description: "甲", preview: "**A**" },
      { label: "B", description: "乙" },
    ],
  }];
  adapter.start({
    toolName: "ask_user_question",
    toolCallId: "bridge-ask",
    args: { questions },
  });
  adapter.prompt({
    questions: [{
      ...questions[0],
      options: questions[0].options.map(option => ({
        label: option.label,
        description: option.description,
        hasPreview: Boolean(option.preview),
      })),
    }],
  });
  const ui = {
    custom: async (factory) =>
      new Promise(async resolve => {
        await factory(
          { requestRender() {} },
          {},
          {},
          resolve,
        );
      }),
  };
  const dialogs = bridgeDialogs(ui, () => "package-session", () => {}, {
    takeCustom: async factory => adapter.take(factory),
  });
  const resultPromise = ui.custom(
    async function QuestionnaireSession() {
      return { render: () => [], handleInput() {} };
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  const [request] = dialogs.list();
  assert.equal(request.packageId, "@juicesharp/rpiv-ask-user-question");
  dialogs.respond(
    request.id,
    {
      draft: [{ kind: "option", option: 0, notes: "说明" }],
      globalNote: "整体备注",
    },
    false,
  );
  assert.deepEqual(await resultPromise, {
    answers: [{
      questionIndex: 0,
      question: "选择方案？",
      kind: "option",
      answer: "A",
      preview: "**A**",
      notes: "说明",
    }],
    cancelled: false,
    globalNote: "整体备注",
  });
  dialogs.close();
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
    assert.equal((await queued.json()).delivery, "queued");
    await events.get("message_update")(
      { message: { role: "assistant", content: "old response" } },
      ctx,
    );
    branch.push({
      id: "queued-entry",
      type: "message",
      timestamp: 1600,
      message: {
        role: "user",
        content: [{ type: "text", text: "queued prompt" }],
      },
    });
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
    assert.deepEqual(queuedStarted.patch.pendingUserMessages || [], []);
    await events.get("agent_end")({}, ctx);
    let failedSubmissionCleared;
    do {
      failedSubmissionCleared = await nextEvent();
    } while (failedSubmissionCleared.patch?.responseWaitStartedAt !== null);
    assert.deepEqual(failedSubmissionCleared.patch.pendingUserMessages || [], []);
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
    const imageOnly = await fetch(new URL("/api/action", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "send",
        sessionId: "bridge-session",
        text: "",
        images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
        mode: "followUp",
      }),
    });
    assert.equal(imageOnly.status, 200);
    assert.deepEqual(sent[2][0], [
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ]);
    assert.deepEqual(sent[2][1], { deliverAs: "followUp" });
  } finally {
    await reader?.cancel();
    await events.get("session_shutdown")();
    delete globalThis[Symbol.for("pi-atom-web.reload-handoff")];
  }
});

test("multi checkboxes and free text survive each other's edits", () => {
  // 回归用户报告的 bug：选中自定义输入框会清空已勾选的复选框，
  // 再次勾选复选框又会清空自定义输入并取消它的勾选态。
  const questions = [
    {
      header: "多选",
      question: "要点哪些？",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    },
  ];
  // UI 三步操作后的草稿：勾选 A、输入文本、再勾选 C
  const draft = {
    kind: "multi",
    option: 0,
    options: [0, 2],
    custom: true,
    text: "自定义",
    notes: "",
  };
  const result = buildAskUserResult(questions, [draft]);
  assert.deepEqual(result.answers, [
    {
      questionIndex: 0,
      question: "要点哪些？",
      kind: "multi",
      answer: null,
      // 自由文本作为额外 selected 项（宿主 multi 答案只有 selected 数组）
      selected: ["A", "C", "自定义"],
    },
  ]);
  // 既无勾选也无文本才算未答
  assert.deepEqual(
    buildAskUserResult(questions, [{ kind: "multi", options: [], custom: false, text: "" }]).answers,
    [],
  );
});
