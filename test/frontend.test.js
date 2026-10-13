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
  stateLineText,
  toolSummary,
  toolCommand,
  toolFilePath,
  toolInputRows,
  toolTitleArgument,
} from "../web/components/conversation/ToolCallBlock.js";
import {
  annotateIntraLine,
  wordSegments,
} from "../web/components/conversation/wordDiff.js";
import {
  codeBlock,
  renderInlineMarkdown,
  stripInlineMarkdown,
} from "../web/markdown.js";
import {
  activityLook,
  nextActivityTab,
  sortActivityTabs,
  EXTENSION_REQUEST_PRIORITY,
  EXTENSION_REQUEST_TONE,
} from "../web/components/composer/ActivityBar.js";
import {
  CONTENT_WIDTH_STORAGE_KEY,
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  clampContentWidth,
  maxContentWidth,
  readStoredContentWidth,
  storeContentWidth,
} from "../web/components/layout/ColumnResizer.js";
import { VIEW_TABS, VISIBLE_TABS, nextTab } from "../web/components/layout/ViewTabs.js";
import { contextSummaries } from "../web/views/ContextView.js";
import { compactionPreview } from "../web/components/conversation/MessageItem.js";
import { compactionDoneText } from "../web/components/conversation/CompactionStatus.js";
import {
  SETTINGS_SECTIONS,
  nextSection,
} from "../web/views/SettingsView.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VIEWS,
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
  isCompactionMessage,
  isManualCompactionMessage,
  splitRunningTail,
  turnCounts,
  turnTitle,
  turnTitleParts,
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
    steers: 0,
    compactions: 0,
  });
  // 分组只统计中间过程：最终输出那条正文不计入
  assert.deepEqual(buildTurnGroup(messages).counts, {
    thinking: 2,
    tools: 2,
    skills: 1,
    texts: 1,
    steers: 0,
    compactions: 0,
  });
  assert.equal(
    turnTitle({ thinking: 2, tools: 2, skills: 1, texts: 1 }),
    "思考2 · 工具调用2 · 技能调用1 · 消息1",
  );
  // 「引导」与「压缩」是本轮的元信息：排在流程计数之后，压缩固定垫底
  assert.equal(
    turnTitle({
      steers: 3,
      compactions: 2,
      thinking: 2,
      tools: 2,
      skills: 1,
      texts: 1,
    }),
    "思考2 · 工具调用2 · 技能调用1 · 消息1 · 引导3 · 压缩2",
  );
  assert.equal(turnTitle({ steers: 1, compactions: 1 }), "引导1 · 压缩1");
  assert.equal(turnTitle({ compactions: 1 }), "压缩1");
  assert.equal(
    turnTitle({ thinking: 0, tools: 3, skills: 0, texts: 2 }),
    "工具调用3 · 消息2",
  );
  assert.equal(turnTitle({ thinking: 1, tools: 0, skills: 0, texts: 0 }), "思考1");
  assert.equal(turnTitle({ thinking: 0, tools: 0, skills: 0, texts: 0 }), "");
  // 页面上数量是独立的徽片，所以结构化的分段与纯文本同样输出
  assert.deepEqual(
    turnTitleParts({ thinking: 2, tools: 2, skills: 1, texts: 1 }),
    [
      { label: "思考", value: 2 },
      { label: "工具调用", value: 2 },
      { label: "技能调用", value: 1 },
      { label: "消息", value: 1 },
    ],
  );
  assert.deepEqual(turnTitleParts({}), []);
  assert.deepEqual(buildTurnGroup(messages).titleParts, [
    { label: "思考", value: 2 },
    { label: "工具调用", value: 2 },
    { label: "技能调用", value: 1 },
    { label: "消息", value: 1 },
  ]);
});

test("steering messages join the turn they interrupted and trail the title", () => {
  const messages = [
    { id: "u1", role: "user", content: "原始问题" },
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
    },
    { id: "r1", role: "toolResult", toolCallId: "t1", content: "ok" },
    { id: "u2", role: "user", content: "补一句", delivery: "steer" },
    {
      id: "a2",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "重新定向" },
        { type: "text", text: "最终答案" },
      ],
    },
  ];
  const items = groupMessages(messages, {});
  // 引导消息不切断分组：整轮仍然只有一个折叠块，引导气泡在块内
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "group", "message"],
  );
  assert.equal(items[0].message.id, "u1");
  assert.equal(items[2].message.id, "a2");
  const { group } = items[1];
  assert.equal(group.counts.steers, 1);
  assert.deepEqual(
    group.intermediate.map((message) => message.id),
    ["a1", "r1", "u2", "a2"],
  );
  // 标题里「引导」排在流程计数之后（倒数第二），最终输出的正文不计入
  assert.deepEqual(group.titleParts, [
    { label: "思考", value: 1 },
    { label: "工具调用", value: 1 },
    { label: "引导", value: 1 },
  ]);
  assert.equal(group.title, "思考1 · 工具调用1 · 引导1");
  // 普通用户输入仍然切断分组
  const split = groupMessages(
    [...messages, { id: "u3", role: "user", content: "下一个问题" }],
    {},
  );
  assert.equal(
    split.filter((item) => item.kind === "group").length,
    1,
  );
  assert.equal(split[split.length - 1].message.id, "u3");
});

test("compaction joins the turn as an intermediate step and trails the title", () => {
  const messages = [
    { id: "u1", role: "user", content: "继续查" },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看常量" },
        { type: "toolCall", id: "t1", name: "ctx_execute", arguments: {} },
      ],
    },
    { id: "r1", role: "toolResult", toolCallId: "t1", content: "4096" },
    // 自动压缩发生在同一个 agent run 内部，不该把一个连续任务切成两轮
    { id: "c1", role: "compactionSummary", summary: "已压缩", tokensBefore: 200163 },
    {
      id: "a2",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "齐了" },
        { type: "text", text: "结论如此" },
      ],
    },
  ];
  const items = groupMessages(messages, {});
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "group", "message"],
  );
  const { group } = items[1];
  assert.deepEqual(
    group.intermediate.map((message) => message.id),
    ["a1", "r1", "c1", "a2"],
  );
  assert.equal(group.counts.compactions, 1);
  // 「压缩」始终排在最后
  assert.deepEqual(group.titleParts, [
    { label: "思考", value: 2 },
    { label: "工具调用", value: 1 },
    { label: "压缩", value: 1 },
  ]);
  assert.equal(group.title, "思考2 · 工具调用1 · 压缩1");
});

// 手动 `/compact` 不是模型自己执行的一步，而是用户显式按下的页面边界（用户 2026-09-23）：
// 它不能钻进 `disclosure-block turn-group`，得自己单独渲染。
test("a manual compaction is a page boundary instead of a step of the turn", () => {
  const manual = {
    id: "c-manual",
    role: "compactionSummary",
    summary: "手动压缩",
    tokensBefore: 200163,
    compactionReason: "manual",
  };
  assert.equal(isManualCompactionMessage(manual), true);
  assert.equal(isCompactionMessage(manual), false);
  assert.equal(
    isCompactionMessage({ id: "c-auto", role: "compactionSummary", summary: "自动", compactionReason: "threshold" }),
    true,
  );

  const items = groupMessages(
    [
      { id: "u1", role: "user", content: "继续查" },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看常量" },
          { type: "toolCall", id: "t1", name: "ctx_execute", arguments: {} },
        ],
      },
      { id: "r1", role: "toolResult", toolCallId: "t1", content: "4096" },
      // 自动压缩：仍算本轮的一步，并计入标题
      {
        id: "c-auto",
        role: "compactionSummary",
        summary: "自动压缩",
        tokensBefore: 200163,
        compactionReason: "threshold",
      },
      {
        id: "a2",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "齐了" },
          { type: "text", text: "结论如此" },
        ],
      },
      // 手动压缩：单独一条条目，不钻进前面的折叠组，也不计入标题
      manual,
    ],
    {},
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "group", "message", "message"],
  );
  const { group } = items[1];
  assert.deepEqual(
    group.intermediate.map((message) => message.id),
    ["a1", "r1", "c-auto", "a2"],
  );
  assert.equal(group.counts.compactions, 1);
  assert.equal(group.title, "思考2 · 工具调用1 · 压缩1");
  assert.equal(items[3].message.id, "c-manual");
});

test("a compaction alone still counts as the turn's middle", () => {
  const items = groupMessages(
    [
      { id: "u1", role: "user", content: "问" },
      { id: "c1", role: "compactionSummary", summary: "已压缩", tokensBefore: 10 },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "答" }] },
    ],
    {},
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "group", "message"],
  );
  assert.equal(items[1].group.title, "压缩1");
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
  assert.equal(items[0].group.title, "思考2 · 工具调用1");
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

test("only the running turn keeps its group expanded", () => {
  const process = (id) => ({
    id,
    role: "assistant",
    content: [{ type: "toolCall", id: `t-${id}`, name: "bash", arguments: {} }],
  });
  const notice = { id: "n1", role: "notification", level: "info", content: "通知" };
  const user = (id) => ({ id, role: "user", content: "继续" });

  // 本轮已经结束（默认 running=false）：连末尾那一组也折叠
  const tail = groupMessages([process("a1"), notice, process("a2")]);
  assert.deepEqual(
    tail.filter((item) => item.kind === "group").map((item) => item.keepOpen),
    [false, false],
  );
  // 通知不折叠（只切断分组）
  assert.equal(tail[1].kind, "message");

  // 正在进行：只有末尾那一轮展开，它之前的分组一律折叠
  const withUser = groupMessages(
    [process("a1"), notice, process("a2"), user("u1"), process("a3")],
    { running: true },
  );
  assert.deepEqual(
    withUser
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, false, true],
  );

  // 用户输入不再提前折叠上一轮；末尾展不展开只看 running
  assert.equal(
    groupMessages([process("a1")], { nextUserInput: true })[0].keepOpen,
    false,
  );
  assert.equal(groupMessages([process("a1")], { running: true })[0].keepOpen, true);
});

test("手动折叠父级会级联收起子级，之后子级自己展开则压过级联", () => {
  setActivePinia(createPinia());
  const store = useConversationStore();
  const turn = "t1";
  const stage = "t1:stage-0";
  const card = "m1-thinking-0";
  // 用户手动展开过中间过程组与它里面的一张卡片
  store.setDisclosure(stage, true);
  store.setDisclosure(card, true);
  assert.equal(store.disclosure(stage, false, [turn]), true);
  assert.equal(store.disclosure(card, false, [turn, stage]), true);
  // 折叠轮次标题：组与卡片一并收起，且父级再展开也不恢复（用户选定「不恢复」）
  store.markCollapsed(turn);
  assert.equal(store.disclosure(stage, false, [turn]), false);
  assert.equal(store.disclosure(card, false, [turn, stage]), false);
  // 折叠之后用户再手动展开卡片：序号刷新，卡片重新展开，组仍然收起
  store.setDisclosure(card, true);
  assert.equal(store.disclosure(card, false, [turn, stage]), true);
  assert.equal(store.disclosure(stage, false, [turn]), false);
  // 折叠中间过程组：连没有自身记录的卡片（默认展开档）也一并压住
  store.markCollapsed(stage);
  assert.equal(store.disclosure(card, true, [turn, stage]), false);
  // 轮次标题自己没有祖先，不受子级影响
  assert.equal(store.disclosure(turn, true), true);
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

test("a new history revision replaces the abandoned session-tree branch", () => {
  setActivePinia(createPinia());
  const store = useConversationStore();
  store.applySnapshot({
    historyRevision: 0,
    messages: [
      { id: "common", role: "assistant", content: "共同历史" },
      { id: "old-user", role: "user", content: "喂", branch: { index: 1, count: 2, prev: null, next: "new-user" } },
      { id: "old-answer", role: "assistant", content: "旧回答" },
    ],
  });

  store.applyPatch({
    historyRevision: 1,
    messages: [
      { id: "common", role: "assistant", content: "共同历史" },
      { id: "new-user", role: "user", content: "hello", branch: { index: 2, count: 2, prev: "old-user", next: null } },
      { id: "new-answer", role: "assistant", content: "新回答" },
    ],
  });

  assert.equal(store.historyRevision, 1);
  assert.deepEqual(store.messages.map((message) => message.id), [
    "common",
    "new-user",
    "new-answer",
  ]);
  assert.equal(store.messages[1].branch.index, 2);
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

test("middle-step groups stay collapsed unless that turn is running", () => {
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
  // 新口径：折叠只看本轮是否正在进行 —— 没在跑就连末尾那一轮也收起
  assert.deepEqual(
    groupMessages(messages)
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, false],
  );
  // 加载（首次快照 / /reload）：结果完全相同（collapseLoaded 不再参与折叠判定）
  assert.deepEqual(
    groupMessages(messages, { collapseLoaded: true })
      .filter((item) => item.kind === "group")
      .map((item) => item.keepOpen),
    [false, false],
  );
  // 只有正在生成的那一轮展开
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

test("inline markdown titles produce only inline tags and a whitelist without attributes", () => {
  const previous = { marked: globalThis.marked, DOMPurify: globalThis.DOMPurify };
  globalThis.marked = markedLibrary;
  let sanitizeOptions;
  globalThis.DOMPurify = {
    sanitize: (value, options) => {
      sanitizeOptions = options;
      return value;
    },
  };
  try {
    assert.equal(renderInlineMarkdown("消息队列 `3`"), "消息队列 <code>3</code>");
    assert.equal(
      renderInlineMarkdown("**确认** 还是 `跳过`"),
      "<strong>确认</strong> 还是 <code>跳过</code>",
    );
    // tab 是一行高的槽位：块级标记绝不能长出块级盒子
    assert.doesNotMatch(
      renderInlineMarkdown("# 标题\n- 项目"),
      /<(p|ul|li|h1)[\s>]/,
    );
    // 清洗策略：属性全清（tab 自身可点击，不能嵌交互），且不放行 a/img/script
    renderInlineMarkdown("x");
    assert.deepEqual(sanitizeOptions.ALLOWED_ATTR, []);
    for (const tag of ["code", "strong", "em"])
      assert.ok(sanitizeOptions.ALLOWED_TAGS.includes(tag));
    for (const tag of ["a", "img", "script", "p", "iframe"])
      assert.ok(!sanitizeOptions.ALLOWED_TAGS.includes(tag));
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("inline markdown falls back to escaped source instead of a blank or raw title", () => {
  const previous = { marked: globalThis.marked, DOMPurify: globalThis.DOMPurify };
  delete globalThis.marked;
  delete globalThis.DOMPurify;
  try {
    assert.equal(
      renderInlineMarkdown("a <script>alert(1)</script> `b`"),
      "a &lt;script&gt;alert(1)&lt;/script&gt; `b`",
    );
    assert.equal(renderInlineMarkdown(""), "");
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("plain-text activity names drop markdown markers but keep intra-word underscores", () => {
  assert.equal(stripInlineMarkdown("消息队列 `3`"), "消息队列 3");
  assert.equal(stripInlineMarkdown("**确认** 还是 `跳过`"), "确认 还是 跳过");
  assert.equal(stripInlineMarkdown("~~删~~ *斜* 体"), "删 斜 体");
  assert.equal(stripInlineMarkdown("[提问](https://example.com)"), "提问");
  // 包名这类含下划线的标题不能被剔字
  assert.equal(
    stripInlineMarkdown("@juicesharp/rpiv-ask_user_question"),
    "@juicesharp/rpiv-ask_user_question",
  );
  assert.equal(stripInlineMarkdown(undefined), "");
});

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
    idleLimitMs: 0, // 本用例只观察重连退避的延时序列，不要让看门狗混进 setTimer
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

test("top tabs cycle in order and with the keyboard, skipping hidden and disabled ones", () => {
  assert.deepEqual(
    VIEW_TABS.map((tab) => tab.id),
    ["chat", "trace", "context", "settings"],
  );
  // 对话与轨迹共用同一个面板，上下文/设置各自一个。
  assert.equal(VIEW_TABS[0].panel, VIEW_TABS[1].panel);
  assert.notEqual(VIEW_TABS[2].panel, VIEW_TABS[3].panel);
  // 执行轨迹（将来是独立页面）与上下文页暂时隐藏：视图代码保留，但不渲染 tab。
  assert.equal(VIEW_TABS[1].disabled, true);
  assert.deepEqual(
    VIEW_TABS.filter((tab) => tab.hidden).map((tab) => tab.id),
    ["trace", "context"],
  );
  assert.deepEqual(
    VISIBLE_TABS.map((tab) => tab.id),
    ["chat", "settings"],
  );
  assert.equal(nextTab("chat", "ArrowRight"), "settings");
  assert.equal(nextTab("chat", "ArrowLeft"), "settings");
  assert.equal(nextTab("settings", "ArrowRight"), "chat");
  // 暂时隐藏的视图不是可选项，键盘不处理。
  assert.equal(nextTab("context", "Home"), null);
  assert.equal(nextTab("trace", "End"), null);
  assert.equal(nextTab("chat", "Enter"), null);
  assert.equal(nextTab("unknown", "ArrowRight"), null);
});

test("settings sections cycle in the sidebar with the keyboard", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => item.id),
    ["appearance", "session", "connection", "behaviour", "skills", "extensions", "prompts", "definition"],
  );
  assert.equal(nextSection("appearance", "ArrowDown"), "session");
  assert.equal(nextSection("appearance", "ArrowUp"), "definition");
  assert.equal(nextSection("connection", "Home"), "appearance");
  assert.equal(nextSection("session", "End"), "definition");
  assert.equal(nextSection("definition", "ArrowDown"), "appearance");
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
  // 轨迹与上下文页暂时隐藏（将改为独立页面），不再作为默认视图选项。
  assert.equal(normalizeSettings({ defaultView: "trace" }).defaultView, "chat");
  assert.equal(normalizeSettings({ defaultView: "context" }).defaultView, "chat");
  assert.deepEqual(DEFAULT_VIEWS, ["chat"]);
  assert.equal(normalizeSettings({ autoCollapse: "x" }).autoCollapse, true);
  assert.equal(normalizeSettings(null).autoFollow, true);

  // 跟随系统只在系统为深色时变暗。
  assert.equal(resolveDark("dark", false), true);
  assert.equal(resolveDark("light", true), false);
  assert.equal(resolveDark("system", true), true);
  assert.equal(resolveDark("system", false), false);

  storeSettings(
    { defaultView: "chat", autoCollapse: false, autoFollow: true },
    storage,
  );
  assert.deepEqual(JSON.parse(storage.getItem("atom-settings")), {
    defaultView: "chat",
    autoCollapse: false,
    autoFollow: true,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  });
  // 旧记忆里存的「上下文」不会原样写回：先经 normalize 回落到对话页。
  storeSettings(
    normalizeSettings({ defaultView: "context", autoCollapse: true }),
    storage,
  );
  assert.equal(JSON.parse(storage.getItem("atom-settings")).defaultView, "chat");
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

test("activity look: package-specific label/icon/tone with a fallback", () => {
  // 通用扩展请求：默认紫 + 标题作为名字
  const generic = activityLook({ kind: "select", title: "通用请求" });
  assert.deepEqual(generic.tone, EXTENSION_REQUEST_TONE);
  assert.equal(generic.label, "通用请求");
  assert.equal(generic.icon, "box");

  // ask_user_question 用 package 定制：名字「提问」、黄色、专用图标
  const ask = activityLook({
    packageId: "@juicesharp/rpiv-ask-user-question",
    kind: "ask_user_question",
    title: "很长很长的工具标题（不该被当作 tab 名）",
  });
  assert.equal(ask.label, "提问");
  assert.equal(ask.icon, "help");
  assert.notDeepEqual(ask.tone, EXTENSION_REQUEST_TONE);
  for (const key of ["color", "background", "border"])
    assert.match(ask.tone[key], /^#[0-9a-f]{6}$/i, `tone.${key}`);

  // 优先级对所有扩展请求统一为 1000
  assert.equal(EXTENSION_REQUEST_PRIORITY, 1000);

  // 键盘：左右循环、Home/End；无当前项时落到第一个
  const tabs = [
    { id: "a" }, { id: "b" }, { id: "c" },
  ];
  assert.equal(nextActivityTab(tabs, "a", "ArrowRight"), "b");
  assert.equal(nextActivityTab(tabs, "c", "ArrowRight"), "a");
  assert.equal(nextActivityTab(tabs, "a", "ArrowLeft"), "c");
  assert.equal(nextActivityTab(tabs, "b", "Home"), "a");
  assert.equal(nextActivityTab(tabs, "b", "End"), "c");
  assert.equal(nextActivityTab(tabs, null, "ArrowRight"), "a");
  // 只有一个 tab / 无 tab 时不移动
  assert.equal(nextActivityTab([tabs[0]], "a", "ArrowRight"), null);
  assert.equal(nextActivityTab([], "a", "ArrowRight"), null);
});

test("activity tabs sort by priority desc, then by arrival time asc", () => {
  // 优先级大的在左
  const byPriority = sortActivityTabs([
    { id: "a", priority: 1, arrivedAt: 1 },
    { id: "b", priority: 3, arrivedAt: 2 },
    { id: "c", priority: 2, arrivedAt: 3 },
  ]);
  assert.deepEqual(byPriority.map((t) => t.id), ["b", "c", "a"]);

  // 优先级相等时先到的在左
  const byArrival = sortActivityTabs([
    { id: "later", priority: 5, arrivedAt: 200 },
    { id: "first", priority: 5, arrivedAt: 100 },
    { id: "middle", priority: 5, arrivedAt: 150 },
  ]);
  assert.deepEqual(byArrival.map((t) => t.id), ["first", "middle", "later"]);

  // 可正可负：负数排最后
  const withNegative = sortActivityTabs([
    { id: "neg", priority: -5, arrivedAt: 1 },
    { id: "zero", priority: 0, arrivedAt: 2 },
    { id: "pos", priority: 2.5, arrivedAt: 3 },
  ]);
  assert.deepEqual(withNegative.map((t) => t.id), ["pos", "zero", "neg"]);

  // 不修改传入数组
  const source = [
    { id: "a", priority: 1, arrivedAt: 1 },
    { id: "b", priority: 2, arrivedAt: 2 },
  ];
  sortActivityTabs(source);
  assert.deepEqual(source.map((t) => t.id), ["a", "b"]);

  // 缺字段按 0 处理，结果稳定可预测
  assert.deepEqual(
    sortActivityTabs([{ id: "x" }, { id: "y", priority: -1 }]).map((t) => t.id),
    ["x", "y"],
  );

  // 同优先级（扩展请求都是 1000）时按到达顺序稳定排列
  assert.deepEqual(
    sortActivityTabs([
      { id: "a", priority: 1000, arrivedAt: 0 },
      { id: "b", priority: 1000, arrivedAt: 1 },
      { id: "c", priority: 1000, arrivedAt: 2 },
    ]).map((t) => t.id),
    ["a", "b", "c"],
  );
});

test("compaction block preview and completion line use the host numbers", () => {
  // 摘要行：压缩前 token 数带千分位；缺字段/非法值时退化为固定文案，不编造数字。
  assert.equal(compactionPreview(150722), "从150,722个token中压缩");
  assert.equal(compactionPreview(1234567), "从1,234,567个token中压缩");
  assert.equal(compactionPreview(undefined), "上下文已压缩");
  assert.equal(compactionPreview(null), "上下文已压缩");
  assert.equal(compactionPreview(-1), "上下文已压缩");
  // 完成行：耗时沿用助手侧同一套格式（不足一分钟只显示秒）。
  assert.equal(compactionDoneText(168000), "压缩完成（耗时2分钟48秒）");
  assert.equal(compactionDoneText(42000), "压缩完成（耗时42秒）");
  assert.equal(compactionDoneText(0), "压缩完成（耗时0秒）");
});

test("intra-line word diff marks only the changed tokens", () => {
  const oldText = "const speed = usage.output / elapsed;";
  const newText = "const speed = averageSpeed(session) / elapsed;";
  const pair = wordSegments(oldText, newText);
  const changed = (list) =>
    list.filter((segment) => segment.changed).map((segment) => segment.text).join("");
  // 行内只圈出真正改掉的字段，未变的 const/速度变量名/分号不进高亮段。
  assert.equal(changed(pair.removed), "usage.output");
  assert.equal(changed(pair.added), "averageSpeed(session)");
  assert.equal(pair.removed.map((segment) => segment.text).join(""), oldText);
  assert.equal(pair.added.map((segment) => segment.text).join(""), newText);
  // 行首缩进不算改动（与 pi TUI 一致，否则整行看着都像被重写）。
  const indented = wordSegments("    let x = 1;", "    let x = 2;");
  assert.equal(indented.removed[0].changed, false);
  assert.ok(indented.removed[0].text.startsWith("    "));
  assert.equal(indented.added.find((segment) => segment.changed).text, "2");
  // 中文按字为粒度，删掉的整段落在被删那一侧。
  const cjk = wordSegments("平均输出速度（正文与思考）", "平均输出速度");
  assert.equal(
    cjk.removed.filter((segment) => segment.changed).map((segment) => segment.text).join(""),
    "（正文与思考）",
  );
});

test("intra-line annotation pairs equal-length runs and skips the rest", () => {
  const rows = annotateIntraLine([
    { kind: "removed", content: "a = 1;" },
    { kind: "added", content: "a = 2;" },
    { kind: "removed", content: "x = 1;" },
    { kind: "removed", content: "y = 1;" },
    { kind: "added", content: "z = 3;" },
  ]);
  assert.equal(rows[0].segments.find((segment) => segment.changed).text, "1");
  assert.equal(rows[1].segments.find((segment) => segment.changed).text, "2");
  // 删 2 增 1 时不猜哪两行对应，整段按原样显示。
  assert.equal(rows[2].segments, undefined);
  assert.equal(rows[4].segments, undefined);
  // 不修改入参
  assert.equal(
    annotateIntraLine([{ kind: "context", content: "keep" }])[0].segments,
    undefined,
  );
});

test("tool state lines and failure reason surface host errors", () => {
  assert.equal(stateLineText("编辑", "running"), "正在编辑");
  assert.equal(stateLineText("编辑", "done"), "成功编辑");
  // 失败不能再写「成功」；中止是宿主的 isError，措辞分开。
  assert.equal(stateLineText("编辑", "failed"), "编辑失败");
  assert.equal(stateLineText("读取", "aborted"), "读取已中止");
  // 报错正文就是 toolResult 的文本：状态行右侧不再摆一份摘要，完整报错统一由
  // 下方 .tool-failure 块展示（所以这里不再拆首行 / 剩余行）。
  assert.equal(
    resultText({
      isError: true,
      content: [{ type: "text", text: "未找到匹配文本\n  at edit.js:12" }],
    }).trim(),
    "未找到匹配文本\n  at edit.js:12",
  );
  assert.equal(resultText({ content: [] }), "");
});

test("collapsed tool summaries use the output, or the error text on failure", () => {
  // 摘要口径与思考块一致：连续空白与换行都压成单个空格。
  assert.equal(
    toolSummary({ content: [{ type: "text", text: "第1行\n  第2行\t带\t制表\n" }] }),
    "第1行 第2行 带 制表",
  );
  // 报错时输出就是报错信息，直接当摘要。
  assert.equal(
    toolSummary({
      isError: true,
      content: [{ type: "text", text: "未找到匹配文本：\n  oldText: p" }],
    }),
    "未找到匹配文本： oldText: p",
  );
  // 运行中用 partialResult；两者都没有时不编摘要（返回空串，前端不渲染）。
  assert.equal(toolSummary(null, { partialResult: "已经跑出来的\n输出" }), "已经跑出来的 输出");
  assert.equal(toolSummary(null, undefined), "");
  assert.equal(toolSummary({ content: [{ type: "text", text: "   \n " }] }), "");
  // 超长截断（CSS 之外再兜一层，避免一行里塞几百 KB 文本）
  const long = toolSummary({ content: [{ type: "text", text: "x".repeat(400) }] });
  assert.equal(long.length, 301);
  assert.ok(long.endsWith("…"));
});

test("中间过程按正文块切成若干中间过程组，正文本身平铺在组之间", () => {
  const group = buildTurnGroup([
    {
      id: "s-a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一步" },
        { type: "toolCall", id: "s-c1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { id: "s-r1", role: "toolResult", toolCallId: "s-c1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    {
      id: "s-a2",
      role: "assistant",
      content: [
        { type: "text", text: "第一段说明" },
        { type: "thinking", thinking: "第二步" },
      ],
    },
    { id: "s-a3", role: "assistant", content: [{ type: "text", text: "最终输出" }] },
  ]);
  // 组1 / 消息1 / 组2；最终输出仍在轮次分组外面
  assert.deepEqual(group.body.map((item) => item.kind), ["stage", "text", "stage"]);
  const [first, separator, second] = group.body;
  // 组标题只算本组：两段思考各算自己那一组
  assert.deepEqual(first.stage.titleParts, [
    { label: "思考", value: 1 },
    { label: "工具调用", value: 1 },
  ]);
  assert.deepEqual(second.stage.titleParts, [{ label: "思考", value: 1 }]);
  // 工具结果跟着前面的工具调用进同一组，不切断分组
  assert.deepEqual(first.stage.items.map((item) => [item.offset, item.message.id]), [
    [0, "s-a1"],
    [0, "s-r1"],
  ]);
  // 平铺的「消息」只带那一个正文块；offset 是它原本的下标（思考块身份 = `${id}-thinking-${下标}`）
  assert.equal(separator.unit.offset, 0);
  assert.deepEqual(separator.unit.message.content, [{ type: "text", text: "第一段说明" }]);
  assert.deepEqual(second.stage.items.map((item) => [item.offset, item.message.content[0].type]), [
    [1, "thinking"],
  ]);
  // 轮次标题仍是全轮总数（各组之和 + 平铺的消息）
  assert.equal(group.title, "思考2 · 工具调用1 · 消息1");
  // 组 key 带轮次前缀且连续，空组不占号
  assert.deepEqual(group.stages.map((stage) => stage.key), [
    "turn-s-a1:stage-0",
    "turn-s-a1:stage-1",
  ]);
});

test("字符串正文与没有块的 assistant 消息不会被切组吞掉", () => {
  const group = buildTurnGroup([
    { id: "q-a1", role: "assistant", content: "历史消息" },
    {
      id: "q-a2",
      role: "assistant",
      content: [
        { type: "toolCall", id: "q-c1", name: "read", arguments: { path: "a.ts" } },
      ],
    },
  ]);
  assert.deepEqual(group.body.map((item) => item.kind), ["text", "stage"]);
  assert.equal(group.body[0].unit.message.content, "历史消息");
  assert.equal(group.body[0].unit.offset, 0);
  assert.deepEqual(group.stages[0].items.map((item) => item.message.id), ["q-a2"]);
});

test("splitRunningTail 把还在进行的那一整轮交给 live 区（按轮分流）", () => {
  const ids = (list) => list.map((message) => message.id);
  const done = [
    { id: "s-u1", role: "user", content: "上一问" },
    { id: "s-a1", role: "assistant", content: [{ type: "text", text: "上一答" }] },
    { id: "s-u2", role: "user", content: "这一问" },
  ];
  const run = [
    {
      id: "s-a2",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看" },
        { type: "toolCall", id: "s-c1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    {
      id: "s-r1",
      role: "toolResult",
      toolCallId: "s-c1",
      toolName: "bash",
      content: [{ type: "text", text: "a.ts" }],
      isError: false,
    },
  ];
  const messages = [...done, ...run];
  const split = splitRunningTail(messages, { running: true });
  assert.deepEqual(ids(split.history), ["s-u1", "s-a1", "s-u2"]);
  assert.deepEqual(ids(split.tail), ["s-a2", "s-r1"]);
  // 本轮结束（running 变假）后整轮回到历史，live 区不再摘任何东西。
  const idle = splitRunningTail(messages, { running: false });
  assert.equal(idle.tail.length, 0);
  assert.deepEqual(ids(idle.history), ids(messages));
  // 乐观用户消息已经代表新的一轮（只是还没落库）：这时不摘尾，
  // 免得把上一轮的尾巴错并到新一轮里。
  const pending = splitRunningTail(messages, {
    running: true,
    hasPendingUser: true,
  });
  assert.equal(pending.tail.length, 0);
  assert.deepEqual(ids(pending.history), ids(messages));
  // 移交不跳：live 区自己算出的轮次分组 key 必须与历史里那一组的 key 完全一致
  // （折叠状态与级联水位线都按 blockKey 记账）。
  const groups = groupMessages(messages, { running: true }).filter(
    (entry) => entry.kind === "group",
  );
  assert.equal(
    buildTurnGroup(split.tail).key,
    groups[groups.length - 1].group.key,
  );
});
