import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { marked as markedLibrary } from "marked";
import {
  consumeToken,
  createEventBatcher,
  createEventStream,
  createSseParser,
} from "../web/api/event-stream.js";
import {
  applyConversationSnapshot,
  buildToolContext,
  contentBlocks,
  useConversationStore,
} from "../web/stores/conversation.js";
import { formatDuration } from "../web/components/conversation/ToolCallBlock.js";
import { skillLabel } from "../web/components/conversation/ToolCallBlock.js";
import {
  CONTENT_WIDTH_STORAGE_KEY,
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  clampContentWidth,
  maxContentWidth,
  readStoredContentWidth,
  storeContentWidth,
} from "../web/components/layout/ColumnResizer.js";

test("skill reads follow the host definition: read tool plus a SKILL.md basename", () => {
  assert.equal(
    skillLabel("read", { path: ".agents/skills/pi-vue-nobuild/SKILL.md" }),
    "pi-vue-nobuild",
  );
  assert.equal(
    skillLabel("read", {
      file_path: "C:\\Users\\me\\.pi\\agent\\skills\\wj-memory\\SKILL.md",
    }),
    "wj-memory",
  );
  // file_path 优先于 path（与宿主一致）
  assert.equal(skillLabel("read", { file_path: "/a/SKILL.md", path: "b/SKILL.md" }), "a");
  // 目录名缺失或只有盘符时回退到文件名
  assert.equal(skillLabel("read", { path: "SKILL.md" }), "SKILL.md");
  assert.equal(skillLabel("read", { path: "C:\\SKILL.md" }), "SKILL.md");
  assert.equal(skillLabel("read", { path: "a/SKILL.md/" }), "a");
  // 大小写敏感、非 read 工具、参数缺失都不算技能加载
  assert.equal(skillLabel("read", { path: "a/skill.md" }), "");
  assert.equal(skillLabel("read", { path: "NOTSKILL.md" }), "");
  assert.equal(skillLabel("read", { path: "README.md" }), "");
  assert.equal(skillLabel("read", { path: "a/SKILL.md.bak" }), "");
  assert.equal(skillLabel("ctx_execute_file", { path: "a/SKILL.md" }), "");
  assert.equal(skillLabel("READ", { path: "a/SKILL.md" }), "a");
  assert.equal(skillLabel("read", undefined), "");
  assert.equal(skillLabel("read", { path: "" }), "");
  assert.equal(skillLabel("read", { path: 42 }), "");
});

test("content width clamps to the viewport and round-trips through storage", () => {
  const entries = new Map();
  const storage = {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, value),
  };
  assert.equal(DEFAULT_CONTENT_WIDTH, 860);
  assert.equal(MIN_CONTENT_WIDTH, 520);
  assert.equal(readStoredContentWidth(storage), DEFAULT_CONTENT_WIDTH);
  assert.equal(readStoredContentWidth(undefined), DEFAULT_CONTENT_WIDTH);

  // 上限留出视口空隙，但绝不把默认列压窄。
  assert.equal(maxContentWidth(1280), 1248);
  assert.equal(maxContentWidth(800), DEFAULT_CONTENT_WIDTH);
  assert.equal(clampContentWidth(1400, 1280), 1248);
  assert.equal(clampContentWidth(1400, 600), DEFAULT_CONTENT_WIDTH);
  assert.equal(clampContentWidth(100, 1280), MIN_CONTENT_WIDTH);
  assert.equal(clampContentWidth(Number.NaN, 1280), DEFAULT_CONTENT_WIDTH);

  storeContentWidth(1040.4, storage);
  assert.equal(entries.get(CONTENT_WIDTH_STORAGE_KEY), "1040");
  assert.equal(readStoredContentWidth(storage), 1040);
  storeContentWidth("oops", storage);
  assert.equal(readStoredContentWidth(storage), DEFAULT_CONTENT_WIDTH);
});

test("sub-second durations use a readable collapsed label and retain milliseconds when expanded", () => {
  assert.equal(formatDuration(0, false), "<1s");
  assert.equal(formatDuration(999, false), "<1s");
  assert.equal(formatDuration(999, true), "0s 999ms");
  assert.equal(formatDuration(1000, false), "1s");
});
import { renderMarkdown } from "../web/markdown.js";

test("token moves from fragment into session storage without accepting malformed values", () => {
  const storage = new Map();
  const location = {
    hash: "#" + "a".repeat(64),
    pathname: "/chat",
    search: "?from=tui",
  };
  const calls = [];
  const history = {
    state: { route: "chat" },
    replaceState(...args) {
      calls.push(args);
    },
  };
  assert.equal(consumeToken(location, storage, history), "a".repeat(64));
  assert.deepEqual(calls, [[{ route: "chat" }, "", "/chat?from=tui"]]);
  assert.equal(storage.get("atom-token"), "a".repeat(64));
  assert.equal(
    consumeToken({ hash: "#bad" }, storage, history),
    "a".repeat(64),
  );
});

test("SSE parser handles split frames and cancellation-safe trailing data", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"a"'), []);
  assert.deepEqual(parser.push(":1}\n\n: heartbeat\n\n"), [{ a: 1 }]);
  assert.deepEqual(parser.flush(), []);
});

test("conversation snapshot preserves unchanged history entity references and remembers manual thinking state", () => {
  const target = {
    messages: [],
    messageById: new Map(),
    liveMessage: null,
    thinkingOpen: new Map(),
    thinkingTouched: new Set(),
  };
  const content = [{ type: "thinking", thinking: "one" }];
  applyConversationSnapshot(target, {
    messages: [{ id: "m1", role: "assistant", content }],
  });
  const original = target.messages[0];
  target.thinkingTouched.add("m1-thinking-0");
  target.thinkingOpen.set("m1-thinking-0", true);
  applyConversationSnapshot(target, {
    messages: [{ id: "m1", role: "assistant", content }],
  });
  assert.equal(target.messages[0], original);
  assert.equal(target.thinkingOpen.get("m1-thinking-0"), true);
});

test("live patches do not replace history and null clears the live turn", () => {
  const target = {
    messages: [],
    messageById: new Map(),
    liveMessage: null,
    thinkingOpen: new Map(),
    thinkingTouched: new Set(),
    thinkingTimes: new Map(),
  };
  applyConversationSnapshot(target, {
    messages: [{ id: "m1", role: "assistant", content: "done" }],
    liveMessage: { id: "run-1", role: "assistant", content: "a" },
  });
  const original = target.messages[0];
  // Mirror the store's patch path: live updates never enter snapshot normalization.
  target.liveMessage = { id: "run-1", role: "assistant", content: "ab" };
  assert.equal(target.messages[0], original);
  target.liveMessage = null;
  assert.equal(target.liveMessage, null);
});

test("tool context joins results by toolCallId even when history entities have their own ids", () => {
  const messages = [
    {
      id: "assistant-entry",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.txt" },
        },
      ],
    },
    {
      id: "result-entry",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: "done",
    },
  ];
  const running = [
    {
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a.txt" },
      partialResult: "partial",
    },
  ];
  const timing = { startedAt: 10, durationMs: 25 };
  const context = buildToolContext(messages, running, { "call-1": timing });
  assert.equal(context.calls.get("call-1"), messages[0].content[0]);
  assert.equal(context.results.get("call-1"), messages[1]);
  assert.equal(context.running.get("call-1"), running[0]);
  assert.equal(context.timings.get("call-1"), timing);
  assert.deepEqual(contentBlocks("streamed text"), []);
});

test("snapshot keeps a running tool attached to a tool call that already entered history", () => {
  setActivePinia(createPinia());
  const conversation = useConversationStore();
  const running = {
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "a.txt" },
    partialResult: "partial",
    startedAt: 10,
  };
  conversation.applySnapshot({
    messages: [
      {
        id: "assistant-entry",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "a.txt" },
          },
        ],
      },
    ],
    liveMessage: null,
    tools: [running],
    toolTimings: {},
  });
  assert.deepEqual(conversation.historyTools.running.get("call-1"), running);
});

test("completed live thinking keeps manual state and frozen timing under its history id", () => {
  setActivePinia(createPinia());
  const conversation = useConversationStore();
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    conversation.applySnapshot({
      messages: [],
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [{ type: "thinking", thinking: "work" }],
      },
      tools: [],
      toolTimings: {},
    });
    conversation.setThinking("live-1-thinking-0", true);
    Date.now = () => 1_640;
    conversation.applyPatch({
      messages: [
        {
          id: "history-1",
          liveId: "live-1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "work" }],
        },
      ],
      liveMessage: null,
    });
    assert.equal(
      conversation.thinkingTouched.has("history-1-thinking-0"),
      true,
    );
    assert.equal(conversation.thinkingOpen.get("history-1-thinking-0"), true);
    assert.deepEqual(conversation.thinkingTimes.get("history-1-thinking-0"), {
      startedAt: 1_000,
      durationMs: 640,
    });
    assert.equal(conversation.thinkingTimes.has("live-1-thinking-0"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("thinking stops timing as soon as later content appears in the same live turn", () => {
  setActivePinia(createPinia());
  const conversation = useConversationStore();
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    conversation.applySnapshot({
      messages: [],
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [{ type: "thinking", thinking: "work" }],
      },
      tools: [],
      toolTimings: {},
    });
    assert.deepEqual(conversation.thinkingTimes.get("live-1-thinking-0"), {
      startedAt: 1_000,
    });

    // 正文开始：思考到此结束，正文与工具调用的时间不再计入。
    Date.now = () => 2_500;
    conversation.applyPatch({
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "work" },
          { type: "text", text: "answer" },
        ],
      },
    });
    assert.deepEqual(conversation.thinkingTimes.get("live-1-thinking-0"), {
      startedAt: 1_000,
      durationMs: 1_500,
    });

    // 同一条消息继续追加正文与工具调用，已结算的思考耗时不再增长。
    Date.now = () => 9_000;
    conversation.applyPatch({
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "work" },
          { type: "text", text: "answer with more detail" },
          { type: "toolCall", id: "call-1", name: "bash", input: {} },
        ],
      },
    });
    assert.deepEqual(conversation.thinkingTimes.get("live-1-thinking-0"), {
      startedAt: 1_000,
      durationMs: 1_500,
    });

    // 末尾的第二个思考块独立计时，并在下一段正文出现时立即结算。
    Date.now = () => 10_000;
    conversation.applyPatch({
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "work" },
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "again" },
        ],
      },
    });
    assert.deepEqual(conversation.thinkingTimes.get("live-1-thinking-2"), {
      startedAt: 10_000,
    });

    Date.now = () => 10_400;
    conversation.applyPatch({
      liveMessage: {
        id: "live-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "work" },
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "again" },
          { type: "text", text: "tail" },
        ],
      },
    });
    assert.deepEqual(conversation.thinkingTimes.get("live-1-thinking-2"), {
      startedAt: 10_000,
      durationMs: 400,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("visual event batching merges patches once per frame and has a background fallback", () => {
  const delivered = [],
    frames = [],
    timers = [];
  const batcher = createEventBatcher((value) => delivered.push(value), {
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame() {},
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer() {},
  });
  batcher.enqueue({
    type: "patch",
    schemaVersion: 1,
    streamId: "s",
    sessionId: "x",
    sequence: 1,
    patch: { busy: false },
  });
  batcher.enqueue({
    type: "patch",
    schemaVersion: 1,
    streamId: "s",
    sessionId: "x",
    sequence: 2,
    patch: { liveMessage: { id: "live", role: "assistant", content: "a" } },
  });
  assert.deepEqual(delivered, []);
  frames[0]();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sequence, 2);
  assert.deepEqual(delivered[0].patch, {
    busy: false,
    liveMessage: { id: "live", role: "assistant", content: "a" },
  });
  batcher.enqueue({
    type: "patch",
    schemaVersion: 1,
    streamId: "s",
    sessionId: "x",
    sequence: 3,
    patch: { busy: true },
  });
  timers.at(-1)();
  assert.equal(delivered.at(-1).sequence, 3);
  batcher.stop();
});

test("live unclosed fenced code renders safely without invoking syntax highlighting", () => {
  const previous = {
    marked: globalThis.marked,
    DOMPurify: globalThis.DOMPurify,
    hljs: globalThis.hljs,
  };
  let renderer;
  globalThis.marked = {
    parse(text, options) {
      renderer = options.renderer;
      return renderer.code({
        text: "const x = 1 < 2",
        lang: "js",
        raw: "```js\nconst x = 1 < 2",
      });
    },
  };
  globalThis.DOMPurify = { sanitize: (value) => value };
  globalThis.hljs = {
    getLanguage() {
      throw new Error("live unfinished fence must not highlight");
    },
    highlight() {
      throw new Error("live unfinished fence must not highlight");
    },
    highlightAuto() {
      throw new Error("live unfinished fence must not highlight");
    },
  };
  try {
    const html = renderMarkdown("```js\nconst x = 1 < 2", { live: true });
    assert.match(html, /const x = 1 &lt; 2/);
    assert.match(html, /language-js/);
    assert.equal(typeof renderer.code, "function");
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("Markdown renderer retains the default paragraph and inline renderers", () => {
  const previous = {
    marked: globalThis.marked,
    DOMPurify: globalThis.DOMPurify,
    hljs: globalThis.hljs,
  };
  globalThis.marked = markedLibrary;
  globalThis.DOMPurify = { sanitize: (value) => value };
  globalThis.hljs = {
    getLanguage: () => true,
    highlight: (value) => ({ value }),
    highlightAuto: (value) => ({ value }),
  };
  try {
    assert.equal(
      renderMarkdown("text **bold**"),
      "<p>text <strong>bold</strong></p>\n",
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("a successful reconnect resets exponential backoff before the next disconnect", async () => {
  const timers = [],
    delays = [];
  let requests = 0;
  const event = {
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
    },
  };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  const transport = createEventStream({
    token: "a".repeat(64),
    onEvent() {},
    fetchImpl: async () => {
      requests += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    },
    setTimer(callback, delay) {
      timers.push(callback);
      delays.push(delay);
      return timers.length;
    },
    clearTimer() {},
    random: () => 0,
  });
  const until = async (predicate) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 1_000)
        throw new Error("transport condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await until(() => timers.length === 1);
    timers.shift()();
    await until(() => requests === 2 && timers.length === 1);
    assert.deepEqual(delays, [500, 500]);
  } finally {
    transport.stop();
  }
});
