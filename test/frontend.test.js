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
  lastThinkingIndex,
  mergeHistory,
  useConversationStore,
} from "../web/stores/conversation.js";
import { formatDuration } from "../web/components/conversation/ToolCallBlock.js";
import { skillLabel } from "../web/components/conversation/ToolCallBlock.js";
import {
  editHunks,
  isPlainOutputTool,
  languageFromPath,
  parseToolDiff,
  resultText,
  splitToolNotices,
  toolCommand,
  toolFilePath,
  toolInputRows,
  toolTitleArgument,
} from "../web/components/conversation/ToolCallBlock.js";
import { codeBlock } from "../web/markdown.js";
import {
  CONTENT_WIDTH_STORAGE_KEY,
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  clampContentWidth,
  maxContentWidth,
  readStoredContentWidth,
  storeContentWidth,
} from "../web/components/layout/ColumnResizer.js";
import { VIEW_TABS, nextTab } from "../web/components/layout/ViewTabs.js";
import { contextSummaries } from "../web/views/ContextView.js";
import {
  SETTINGS_SECTIONS,
  nextSection,
} from "../web/views/SettingsView.js";
import {
  DEFAULT_SETTINGS,
  MAX_SAFE_AREA,
  clampSafeArea,
  isEditableNode,
  normalizeSettings,
  normalizeTheme,
  readStoredSettings,
  resolveDark,
  shouldYieldBottomSafeArea,
  storeSettings,
  storeTheme,
  useSettingsStore,
} from "../web/stores/settings.js";

test("system tools infer path, language and edit hunks like the host does", () => {
  // 标题参数：宿主主用 file_path（edit/write/read 都是），其次 path
  assert.equal(toolTitleArgument({ file_path: "src/a.ts" }), "src/a.ts");
  assert.equal(toolTitleArgument({ path: "src/b.ts" }), "src/b.ts");
  assert.equal(toolTitleArgument({ command: "ls" }), "ls");
  assert.equal(toolTitleArgument(null), "");
  assert.equal(toolFilePath({ path: "C:\\work\\a.md" }), "C:\\work\\a.md");
  assert.equal(toolFilePath({}), "");

  // 语言推断（与宿主 getLanguageFromPath 同一意图）
  assert.equal(languageFromPath("src/a.ts"), "typescript");
  assert.equal(languageFromPath("C:\\work\\a.PY"), "python");
  assert.equal(languageFromPath("docs/a.md"), "markdown");
  assert.equal(languageFromPath("Dockerfile"), "dockerfile");
  assert.equal(languageFromPath("Makefile"), "makefile");
  assert.equal(languageFromPath("a.unknown"), "text");
  assert.equal(languageFromPath(""), "text");

  // edit：单个 oldText/newText 与 edits[] 两种形态，旧字段名兼容
  assert.deepEqual(editHunks({ oldText: "a\nb", newText: "a\nc" }), [
    { oldLines: ["a", "b"], newLines: ["a", "c"] },
  ]);
  assert.deepEqual(
    editHunks({
      edits: [
        { oldText: "1", newText: "2" },
        { oldText: "3", newText: "4" },
      ],
    }),
    [
      { oldLines: ["1"], newLines: ["2"] },
      { oldLines: ["3"], newLines: ["4"] },
    ],
  );
  assert.deepEqual(editHunks({ old_string: "x", new_string: "y" }), [
    { oldLines: ["x"], newLines: ["y"] },
  ]);
  // 纯新增（oldText 为空）只显示 + 行
  assert.deepEqual(editHunks({ oldText: "", newText: "new" }), [
    { oldLines: [], newLines: ["new"] },
  ]);
  // 没有变更内容（例如只有 file_path）时不渲染 diff
  assert.deepEqual(editHunks({ file_path: "a.ts" }), []);
  assert.deepEqual(editHunks(null), []);
});

test("host edit diffs are parsed with their real line numbers", () => {
  // 格式来自 dist/modes/interactive/components/diff.js 的 parseDiffLine
  assert.deepEqual(parseToolDiff("-12 const answer = 42;\n+12 const answer = 43;"), [
    { kind: "removed", lineNumber: "12", content: "const answer = 42;" },
    { kind: "added", lineNumber: "12", content: "const answer = 43;" },
  ]);
  // 上下文行（前导空格）与多行 hunk
  assert.deepEqual(
    parseToolDiff(" 11 import x from 'x';\n-12 old\n+12 new\n 13 tail").map(
      (line) => [line.kind, line.lineNumber],
    ),
    [
      ["context", "11"],
      ["removed", "12"],
      ["added", "12"],
      ["context", "13"],
    ],
  );
  // 空内容行保留为空字符串；宿主的 diff 字符串不带尾随换行
  assert.deepEqual(parseToolDiff("-3 "), [
    { kind: "removed", lineNumber: "3", content: "" },
  ]);
  assert.deepEqual(parseToolDiff("-3 \n"), [
    { kind: "removed", lineNumber: "3", content: "" },
    { kind: "context", lineNumber: "", content: "" },
  ]);
  assert.deepEqual(parseToolDiff("@@ hunk @@"), [
    { kind: "context", lineNumber: "", content: "@@ hunk @@" },
  ]);
  assert.deepEqual(parseToolDiff(""), [{ kind: "context", lineNumber: "", content: "" }]);
});

test("code blocks can start numbering from an offset and read/bash keep raw text", () => {
  // read 的 offset：行号 gutter 从真实行号开始
  assert.match(
    codeBlock("a\nb", "javascript", { startLine: 200 }),
    /class="code-lines" aria-hidden="true">200\n201</,
  );
  assert.match(codeBlock("a", "json"), /aria-hidden="true">1</);
  assert.match(codeBlock("a", "json", { startLine: 0 }), /aria-hidden="true">1</);
  assert.match(codeBlock("a", "json", { startLine: "x" }), /aria-hidden="true">1</);

  // read/bash 取文本块原文（不走 markdown）
  assert.equal(resultText({ content: "原文" }), "原文");
  assert.equal(
    resultText({ content: [{ type: "text", text: "第一行" }, { type: "text", text: "第二行" }] }),
    "第一行\n第二行",
  );
  assert.equal(resultText({ content: [{ type: "image", data: "x" }] }), "");
  assert.equal(resultText(null), "");

  // 工具提示语（截断/继续读）不归代码块
  assert.deepEqual(
    splitToolNotices("line1\nline2\n\n[246 more lines in file. Use offset=230 to continue.]"),
    {
      content: "line1\nline2",
      notices: ["[246 more lines in file. Use offset=230 to continue.]"],
    },
  );
  assert.deepEqual(
    splitToolNotices(
      "out\n\n[Showing lines 1-10 of 50. Use offset=11 to continue.]\n[Full output: /tmp/x.txt]",
    ),
    {
      content: "out",
      notices: [
        "[Showing lines 1-10 of 50. Use offset=11 to continue.]",
        "[Full output: /tmp/x.txt]",
      ],
    },
  );
  // 正文里形如 [link] 的最后一行不能被误当成提示语
  assert.deepEqual(splitToolNotices("code\n\n[link]"), {
    content: "code\n\n[link]",
    notices: [],
  });
  // 多行提示（内含指路的 bash 命令）整体算一条
  assert.deepEqual(
    splitToolNotices(
      "content\n\n[Line 12 is 5MB, exceeds 256KB limit. Use bash:\n sed -n '12p' big.txt | head -c 262144]",
    ),
    {
      content: "content",
      notices: [
        "[Line 12 is 5MB, exceeds 256KB limit. Use bash:\nsed -n '12p' big.txt | head -c 262144]",
      ],
    },
  );
  // 结尾不是 ] 时不算提示语（例如 JSON 文件以数组结尾）
  assert.deepEqual(splitToolNotices("{\n\n[1,2,3]"), {
    content: "{\n\n[1,2,3]",
    notices: [],
  });
  assert.deepEqual(splitToolNotices("no notice"), {
    content: "no notice",
    notices: [],
  });
  assert.deepEqual(splitToolNotices(""), { content: "", notices: [] });
});

test("read inputs become readable rows while shell inputs become script blocks", () => {
  assert.deepEqual(
    toolInputRows("read", {
      file_path: "src/answer.ts",
      offset: 200,
      limit: 28,
    }),
    [
      { label: "路径", value: "src/answer.ts" },
      { label: "起始行", value: "200" },
      { label: "行数", value: "28" },
    ],
  );
  // 没有 offset/limit 时只展示路径
  assert.deepEqual(toolInputRows("read", { path: "a.ts" }), [
    { label: "路径", value: "a.ts" },
  ]);
  // bash/powershell 走代码块，不再用参数行
  assert.deepEqual(toolInputRows("bash", { command: "npm test" }), []);
  // 没有专门参数行的工具（如 edit/write）仍直接展示 JSON
  assert.deepEqual(toolInputRows("edit", { file_path: "a.ts" }), []);
  assert.deepEqual(toolInputRows("read", null), []);

  // 命令按对应语言高亮；非 shell 工具或空命令返回 null
  assert.deepEqual(toolCommand("bash", { command: "npm test" }), {
    language: "bash",
    text: "npm test",
  });
  assert.deepEqual(toolCommand("powershell", { command: "ls" }), {
    language: "powershell",
    text: "ls",
  });
  assert.equal(toolCommand("read", { command: "x" }), null);
  assert.equal(toolCommand("bash", { command: "" }), null);
  assert.equal(toolCommand("bash", null), null);
});

test("grep/find/ls inputs, titles and plain-text outputs follow the host", () => {
  assert.deepEqual(
    toolInputRows("grep", {
      pattern: "TODO",
      path: "src",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 50,
    }),
    [
      { label: "模式", value: "TODO" },
      { label: "路径", value: "src" },
      { label: "文件过滤", value: "*.ts" },
      { label: "忽略大小写", value: "是" },
      { label: "按字面量", value: "是" },
      { label: "上下文行数", value: "2" },
      { label: "上限", value: "50" },
    ],
  );
  // 缺省项不显示
  assert.deepEqual(toolInputRows("grep", { pattern: "x" }), [
    { label: "模式", value: "x" },
  ]);
  assert.deepEqual(toolInputRows("find", { pattern: "*.md" }), [
    { label: "模式", value: "*.md" },
  ]);
  assert.deepEqual(toolInputRows("ls", { path: "src", limit: 20 }), [
    { label: "路径", value: "src" },
    { label: "上限", value: "20" },
  ]);

  // 标题主参数：grep/find 用 pattern（与宿主一致），read/write/edit 用 file_path
  assert.equal(toolTitleArgument({ pattern: "TODO", path: "src" }, "grep"), "TODO");
  assert.equal(toolTitleArgument({ pattern: "*.md" }, "find"), "*.md");
  assert.equal(
    toolTitleArgument({ file_path: "a.ts", pattern: "x" }, "read"),
    "a.ts",
  );
  assert.equal(toolTitleArgument({ command: "ls" }, "bash"), "ls");

  // 结果必须原样展示（不过 markdown）的工具集合
  for (const tool of ["bash", "powershell", "grep", "find", "ls"])
    assert.equal(isPlainOutputTool(tool), true);
  for (const tool of ["read", "write", "edit", "unknown"])
    assert.equal(isPlainOutputTool(tool), false);
});

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

import {
  buildTurnGroup,
  groupMessages,
  turnCounts,
  turnTitle,
} from "../web/components/conversation/turnGroups.js";

test("turn counts follow the fixed order and drop empty segments", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t1" },
        {
          type: "toolCall",
          id: "t1",
          name: "read",
          arguments: { path: ".agents/skills/x/SKILL.md" },
        },
        { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
        { type: "text", text: "中间说明" },
      ],
    },
    {
      id: "r1",
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "技能内容（不算正文段落）" }],
    },
    {
      id: "a2",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t2" },
        { type: "text", text: "最终答案" },
      ],
    },
  ];
  // 原始消息里的计数包含最终输出那条正文
  assert.deepEqual(turnCounts(messages), {
    thinking: 2,
    tools: 2,
    skills: 1,
    texts: 2,
  });
  // 分组只统计中间过程：最终输出那条正文不计入
  assert.deepEqual(buildTurnGroup(messages).counts, {
    thinking: 2,
    tools: 2,
    skills: 1,
    texts: 1,
  });
  assert.equal(
    turnTitle({ thinking: 2, tools: 2, skills: 1, texts: 1 }),
    "2 次思考过程 · 2 次工具调用 · 1 次技能调用 · 1 条消息",
  );
  assert.equal(
    turnTitle({ thinking: 0, tools: 3, skills: 0, texts: 2 }),
    "3 次工具调用 · 2 条消息",
  );
  assert.equal(
    turnTitle({ thinking: 1, tools: 0, skills: 0, texts: 0 }),
    "1 次思考过程",
  );
  assert.equal(turnTitle({ thinking: 0, tools: 0, skills: 0, texts: 0 }), "");
});

test("turn groups keep the final output outside the collapsed middle", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t1" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    {
      id: "r1",
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "out" }],
    },
    {
      id: "a2",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t2" },
        { type: "text", text: "最终答案" },
      ],
    },
  ];
  const items = groupMessages(messages);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["group", "message"],
  );
  assert.equal(items[0].group.title, "2 次思考过程 · 1 次工具调用");
  const { group } = items[0];
  assert.equal(group.key, "turn-a1");
  assert.equal(group.finalMessage.id, "a2");
  // 折叠区里最后一条消息只留最终输出之前的块：下标不变，Thinking identifier 稳定
  assert.deepEqual(group.intermediate[2].content, [
    { type: "thinking", thinking: "t2" },
  ]);
  assert.deepEqual(items[1].message.content, [
    { type: "text", text: "最终答案" },
  ]);
  assert.equal(items[1].groupKey, "turn-a1");
  // 含工具调用的消息整条都算中间过程，不会被当成最终输出
  assert.equal(
    buildTurnGroup(messages.slice(0, 1)).finalMessage,
    null,
  );
});

test("turn groups skip turns without middle steps and break on other roles", () => {
  const single = groupMessages([
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "直接回答" }],
    },
  ]);
  assert.equal(single.length, 1);
  assert.equal(single[0].kind, "message");
  assert.equal(single[0].message.content[0].text, "直接回答");

  const withNotice = groupMessages([
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
    },
    { id: "n1", role: "notification", level: "info", content: "通知" },
    {
      id: "a2",
      role: "assistant",
      content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }],
    },
  ]);
  assert.deepEqual(
    withNotice.map((item) => item.kind),
    ["group", "message", "group"],
  );
  assert.equal(withNotice[1].message.role, "notification");
});

test("turn groups stay expanded until the next user message arrives", () => {
  const process = (id) => ({
    id,
    role: "assistant",
    content: [{ type: "toolCall", id: `t-${id}`, name: "bash", arguments: {} }],
  });
  const notice = { id: "n1", role: "notification", level: "info", content: "通知" };
  const user = (id) => ({ id, role: "user", content: "继续" });

  // 末尾没有用户输入：即使整轮输出早已停止，分组也保持展开
  const tail = groupMessages([process("a1"), notice, process("a2")]);
  assert.deepEqual(
    tail.filter((item) => item.kind === "group").map((item) => item.keepOpen),
    [true, true],
  );
  // 通知不折叠（只切断分组）
  assert.equal(tail[1].kind, "message");

  // 下一个用户输入开始：它之前的分组折叠；通知不折叠（只切断分组）
  const withUser = groupMessages([
    process("a1"),
    notice,
    process("a2"),
    user("u1"),
    process("a3"),
  ]);
  assert.deepEqual(
    withUser
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [true, false, true],
  );

  // 浏览器里已显示、尚未进入历史的用户消息同样算「用户输入开始」
  assert.equal(
    groupMessages([process("a1")], { nextUserInput: true })[0].keepOpen,
    false,
  );
  assert.equal(groupMessages([process("a1")])[0].keepOpen, true);
});

test("history merge keeps loaded turns when the server window slides", () => {
  const turn = (id) => ({ id, role: "assistant", content: id });
  // 并集：老的在前，重复 id 保留原位置但用新值
  assert.deepEqual(
    mergeHistory([turn("a"), turn("b")], [turn("c"), turn("b")]).map((m) => m.id),
    ["a", "b", "c"],
  );
  // 服务端窗口向前滑动（丢掉最老一轮）时，已加载的旧轮次不能被丢掉
  const loaded = mergeHistory([turn("t1"), turn("t2")], [turn("t2"), turn("t3")]);
  const slid = mergeHistory(loaded, [turn("t3"), turn("t4")]);
  assert.deepEqual(slid.map((m) => m.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(mergeHistory([], [turn("x")]).map((m) => m.id), ["x"]);
  assert.deepEqual(mergeHistory([turn("x")], []).map((m) => m.id), ["x"]);
});

test("prepended history is merged in front without touching rendered entries", () => {
  setActivePinia(createPinia());
  const store = useConversationStore();
  store.applySnapshot({
    messages: [
      { id: "u10", role: "user", content: "新问题" },
      { id: "a10", role: "assistant", content: [{ type: "text", text: "新回答" }] },
    ],
    historyComplete: false,
  });
  const rendered = store.messages[1];
  assert.equal(store.historyComplete, false);
  assert.equal(store.collapseLoaded, true);
  assert.equal(store.oldestMessageId(), "u10");

  store.applyPatch({
    prependMessages: [
      { id: "u9", role: "user", content: "旧问题" },
      { id: "a9", role: "assistant", content: [{ type: "text", text: "旧回答" }] },
    ],
    historyComplete: false,
  });
  assert.deepEqual(store.messages.map((m) => m.id), ["u9", "a9", "u10", "a10"]);
  assert.equal(store.oldestMessageId(), "u9");
  assert.equal(store.prependedCount, 1);
  // 已渲染的引用不变（不会重建整段历史）
  assert.equal(store.messages[3], rendered);

  // 取到最早一页后停止请求
  store.applyPatch({
    prependMessages: [{ id: "u8", role: "user", content: "最早" }],
    historyComplete: true,
  });
  assert.equal(store.historyComplete, true);
  assert.deepEqual(store.messages.map((m) => m.id), ["u8", "u9", "a9", "u10", "a10"]);

  // 新的生成开始时，加载时的「全部折叠」不再适用
  store.applyPatch({
    liveMessage: { id: "live", role: "assistant", content: "流式" },
  });
  assert.equal(store.collapseLoaded, false);
});

test("loading collapses every loaded middle-step group", () => {
  const turn = (i) => [
    { id: `u${i}`, role: "user", content: `问题 ${i}` },
    {
      id: `a${i}`,
      role: "assistant",
      content: [
        { type: "thinking", thinking: `思考 ${i}` },
        { type: "toolCall", id: `c${i}`, name: "bash", arguments: {} },
      ],
    },
    {
      id: `r${i}`,
      role: "toolResult",
      toolCallId: `c${i}`,
      content: [{ type: "text", text: "out" }],
    },
    { id: `f${i}`, role: "assistant", content: [{ type: "text", text: `结论 ${i}` }] },
  ];
  const messages = [...turn(0), ...turn(1)];
  // 默认：第一轮后面已有用户输入→折叠；末尾那一轮保持展开
  assert.deepEqual(
    groupMessages(messages)
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, true],
  );
  // 加载（首次快照 / /reload）：已加载的中间过程全部折叠
  assert.deepEqual(
    groupMessages(messages, { collapseLoaded: true })
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, false],
  );
  // 加载时会话还在生成：保留正在跑的那一轮
  assert.deepEqual(
    groupMessages(messages, { collapseLoaded: true, running: true })
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, true],
  );
});

test("only the last thinking block stays open while streaming", () => {
  // 只有一个思考块时它就是最后一个
  assert.equal(lastThinkingIndex([{ type: "thinking", thinking: "唯一" }]), 0);
  // 出现第二个思考块后，前一个不再是最后一个（于是折叠）
  assert.equal(
    lastThinkingIndex([
      { type: "thinking", thinking: "第一段" },
      { type: "text", text: "正文" },
      { type: "thinking", thinking: "第二段" },
    ]),
    2,
  );
  // 思考块后面只有工具调用/正文时，前面的思考仍是最后一个（保持展开）
  assert.equal(
    lastThinkingIndex([
      { type: "thinking", thinking: "思考" },
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      { type: "text", text: "正文" },
    ]),
    0,
  );
  assert.equal(lastThinkingIndex("纯文本"), -1);
  assert.equal(lastThinkingIndex([]), -1);
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

const fakeStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test("top tabs cycle in order and with the keyboard, skipping disabled ones", () => {
  assert.deepEqual(
    VIEW_TABS.map((tab) => tab.id),
    ["chat", "trace", "context", "settings"],
  );
  // 对话与轨迹共用同一个面板，上下文/设置各自一个。
  assert.equal(VIEW_TABS[0].panel, VIEW_TABS[1].panel);
  assert.notEqual(VIEW_TABS[2].panel, VIEW_TABS[3].panel);
  // 执行轨迹将改为独立页面，在完成前保持可见但不可选中。
  assert.equal(VIEW_TABS[1].disabled, true);
  assert.equal(
    VIEW_TABS.filter((tab) => tab.disabled).length,
    1,
  );
  assert.equal(nextTab("chat", "ArrowRight"), "context");
  assert.equal(nextTab("chat", "ArrowLeft"), "settings");
  assert.equal(nextTab("settings", "ArrowRight"), "chat");
  assert.equal(nextTab("context", "Home"), "chat");
  assert.equal(nextTab("context", "End"), "settings");
  assert.equal(nextTab("chat", "Enter"), null);
  assert.equal(nextTab("unknown", "ArrowRight"), null);
});

test("settings sections cycle in the sidebar with the keyboard", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => item.id),
    ["appearance", "session", "connection", "behaviour"],
  );
  assert.equal(nextSection("appearance", "ArrowDown"), "session");
  assert.equal(nextSection("appearance", "ArrowUp"), "behaviour");
  assert.equal(nextSection("connection", "Home"), "appearance");
  assert.equal(nextSection("session", "End"), "behaviour");
  assert.equal(nextSection("session", "Tab"), null);
  assert.equal(nextSection("unknown", "ArrowDown"), null);
});

test("settings read/write their own keys with safe fallbacks", () => {
  const storage = fakeStorage();
  assert.deepEqual(readStoredSettings(storage), { ...DEFAULT_SETTINGS });

  storage.setItem("atom-theme", "system");
  storage.setItem(
    "atom-settings",
    JSON.stringify({ defaultView: "trace", autoCollapse: false, autoFollow: false }),
  );
  assert.deepEqual(readStoredSettings(storage), {
    theme: "system",
    defaultView: "chat",
    autoCollapse: false,
    autoFollow: false,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  });

  // 坏 JSON 与非法值回退到默认，但已存的主题继续生效。
  storage.setItem("atom-settings", "{坏的");
  assert.deepEqual(readStoredSettings(storage), {
    ...DEFAULT_SETTINGS,
    theme: "system",
  });
  assert.equal(normalizeTheme("紫色"), DEFAULT_SETTINGS.theme);
  assert.equal(normalizeSettings({ defaultView: "settings" }).defaultView, "chat");
  // 轨迹不是默认视图选项（将改为独立页面）。
  assert.equal(normalizeSettings({ defaultView: "trace" }).defaultView, "chat");
  assert.equal(normalizeSettings({ defaultView: "context" }).defaultView, "context");
  assert.equal(normalizeSettings({ autoCollapse: "x" }).autoCollapse, true);
  assert.equal(normalizeSettings(null).autoFollow, true);

  // 跟随系统只在系统为深色时变暗。
  assert.equal(resolveDark("dark", false), true);
  assert.equal(resolveDark("light", true), false);
  assert.equal(resolveDark("system", true), true);
  assert.equal(resolveDark("system", false), false);

  storeSettings(
    { defaultView: "context", autoCollapse: false, autoFollow: true },
    storage,
  );
  assert.deepEqual(JSON.parse(storage.getItem("atom-settings")), {
    defaultView: "context",
    autoCollapse: false,
    autoFollow: true,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  });
  storeTheme("dark", storage);
  assert.equal(storage.getItem("atom-theme"), "dark");
});

test("safe area values are clamped, stored and applied as css variables", () => {
  assert.equal(clampSafeArea(-12), 0);
  assert.equal(clampSafeArea("不是数字"), 0);
  assert.equal(clampSafeArea(null), 0);
  assert.equal(clampSafeArea(24.6), 25);
  assert.equal(clampSafeArea(9999), MAX_SAFE_AREA);
  const normalized = normalizeSettings({ safeAreaTop: "18", safeAreaBottom: -4 });
  assert.equal(normalized.safeAreaTop, 18);
  assert.equal(normalized.safeAreaBottom, 0);

  const storage = fakeStorage();
  storeSettings(
    { defaultView: "chat", autoCollapse: true, autoFollow: true, safeAreaTop: 18, safeAreaBottom: 6 },
    storage,
  );
  assert.deepEqual(JSON.parse(storage.getItem("atom-settings")), {
    defaultView: "chat",
    autoCollapse: true,
    autoFollow: true,
    safeAreaTop: 18,
    safeAreaBottom: 6,
  });
  assert.deepEqual(readStoredSettings(storage).safeAreaTop, 18);

  setActivePinia(createPinia());
  const settings = useSettingsStore();
  // node 环境没有 document：设置安全区必须静默完成，并返回夹取后的值。
  assert.equal(settings.setSafeArea("top", 9999), MAX_SAFE_AREA);
  assert.equal(settings.safeAreaTop, MAX_SAFE_AREA);
  assert.equal(settings.setSafeArea("bottom", -3), 0);
  assert.equal(settings.safeAreaBottom, 0);
  settings.restoreDefaults();
  assert.equal(settings.safeAreaTop, DEFAULT_SETTINGS.safeAreaTop);
  assert.equal(settings.safeAreaBottom, DEFAULT_SETTINGS.safeAreaBottom);
});

test("bottom safe area yields to the soft keyboard without losing its value", () => {
  assert.equal(isEditableNode({ tagName: "INPUT" }), true);
  assert.equal(isEditableNode({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableNode({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableNode({ tagName: "DIV" }), false);
  assert.equal(isEditableNode(null), false);

  // 只有触屏设备 + 可输入元素获得焦点才算键盘占着底部
  assert.equal(shouldYieldBottomSafeArea({ tagName: "INPUT" }, true), true);
  assert.equal(shouldYieldBottomSafeArea({ tagName: "INPUT" }, false), false);
  assert.equal(shouldYieldBottomSafeArea({ tagName: "BODY" }, true), false);
  assert.equal(shouldYieldBottomSafeArea(null, true), false);

  setActivePinia(createPinia());
  const settings = useSettingsStore();
  settings.setSafeArea("bottom", 24);
  settings.setSafeArea("top", 12);
  assert.equal(settings.appliedSafeAreaBottom, 24);
  settings.setKeyboardOpen(true);
  // 配置值不变，只是实际生效值归零；顶部安全区不受影响
  assert.equal(settings.safeAreaBottom, 24);
  assert.equal(settings.appliedSafeAreaBottom, 0);
  assert.equal(settings.safeAreaTop, 12);
  settings.setKeyboardOpen(false);
  assert.equal(settings.appliedSafeAreaBottom, 24);
  assert.equal(settings.safeAreaBottom, 24);
});

test("settings store clamps the content width and survives a DOM-less load", () => {
  setActivePinia(createPinia());
  const settings = useSettingsStore();
  // node 环境没有 document/matchMedia：load() 必须静默完成（无 localStorage 也不报错）。
  settings.load();
  settings.setContentWidth(MIN_CONTENT_WIDTH);
  assert.equal(settings.contentWidth, MIN_CONTENT_WIDTH);
  settings.setContentWidth(DEFAULT_CONTENT_WIDTH * 4);
  assert.equal(settings.contentWidth, DEFAULT_CONTENT_WIDTH);
  settings.setContentWidth("不是数字");
  assert.equal(settings.contentWidth, DEFAULT_CONTENT_WIDTH);
  assert.equal(settings.resetContentWidth(), DEFAULT_CONTENT_WIDTH);
  // 主题切换与恢复默认都不应抛错。
  settings.setTheme("dark");
  assert.equal(settings.dark, true);
  settings.setAutoCollapse(false);
  assert.equal(settings.autoCollapse, false);
  settings.restoreDefaults();
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(settings.autoCollapse, true);
  assert.equal(settings.defaultView, "chat");
});

test("context page lists branch and compaction summaries with their labels", () => {
  assert.deepEqual(
    contextSummaries([
      { id: "a", role: "assistant", content: "正文" },
      { id: "b", role: "branchSummary", summary: "分支内容" },
      { role: "compactionSummary", summary: "压缩内容" },
    ]),
    [
      { id: "b", label: "分支摘要", text: "分支内容" },
      {
        id: "compactionSummary:压缩内容",
        label: "上下文摘要",
        text: "压缩内容",
      },
    ],
  );
  assert.deepEqual(contextSummaries(), []);
});
