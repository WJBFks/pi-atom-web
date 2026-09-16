import { computed, defineComponent, h, onUnmounted, watch } from "vue";
import { writeClipboard } from "../../clipboard.js";
import { icon } from "../../icons.js";
import { codeBlock } from "../../markdown.js";
import { isAbortNotice } from "./abort-notice.js";
import { useConversationClock } from "../../stores/conversation.js";
import MarkdownContent from "./MarkdownContent.js";
import DisclosureBlock from "./DisclosureBlock.js";

const text = (value) =>
  typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);

// pi 系统工具的适配（read/write/edit 等）就放在这里：它们不是第三方 package，
// 不进入 web/packages/。字段名与宿主变持一致：宿主读 file_path ?? path
// （见 dist/core/tools/renderers/edit.js 与 write.js）。
export function toolFilePath(args) {
  if (!args || typeof args !== "object") return "";
  const value = args.file_path ?? args.path;
  return typeof value === "string" ? value.trim() : "";
}

const EXTENSION_LANGUAGES = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};
const FILENAME_LANGUAGES = { dockerfile: "dockerfile", makefile: "makefile" };

/** 按路径推断代码块语言（与宿主 getLanguageFromPath 同一意图，未知回退 text）。 */
export function languageFromPath(path) {
  const name = String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  if (!name) return "text";
  if (FILENAME_LANGUAGES[name.toLowerCase()])
    return FILENAME_LANGUAGES[name.toLowerCase()];
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? EXTENSION_LANGUAGES[match[1].toLowerCase()] || "text" : "text";
}

// edit 的参数可能是单个 {oldText,newText}，也可能是 {edits:[{oldText,newText},...]}
// （与宿主 getRenderablePreviewInput 一致）；旧版字段名 old_string/new_string 兼容。
const textField = (item, ...names) => {
  for (const name of names)
    if (typeof item?.[name] === "string") return item[name];
  return undefined;
};
export function editHunks(args) {
  if (!args || typeof args !== "object") return [];
  const list =
    Array.isArray(args.edits) && args.edits.length ? args.edits : [args];
  return list
    .map((item) => ({
      oldText: textField(item, "oldText", "old_string"),
      newText: textField(item, "newText", "new_string"),
    }))
    .filter((item) => item.oldText !== undefined || item.newText !== undefined)
    .map((item) => ({
      oldLines: item.oldText ? item.oldText.replace(/\n$/, "").split("\n") : [],
      newLines: item.newText ? item.newText.replace(/\n$/, "").split("\n") : [],
    }));
}

// 宿主 edit 结果的 diff 自带行号：`+123 内容` / `-123 内容` / ` 123 内容`
// （与 dist/modes/interactive/components/diff.js 的 parseDiffLine 同一格式）。
// 参数里只有 oldText/newText、拿不到文件行号，所以行号必须来自这里。
export function parseToolDiff(value) {
  return String(value ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*\.\.\.\s*$/.test(line))
    .map((line) => {
      const match = /^([+-\s])(\s*\d*)\s(.*)$/.exec(line);
      if (!match) return { kind: "context", lineNumber: "", content: line };
      return {
        kind:
          match[1] === "-"
            ? "removed"
            : match[1] === "+"
              ? "added"
              : "context",
        lineNumber: match[2].trim(),
        content: match[3],
      };
    });
}

// 标题里的关键参数：宿主对 grep/find 用 pattern、对 read/write/edit 用 file_path。
export function toolTitleArgument(args, tool) {
  if (!args || typeof args !== "object") return "";
  const name = String(tool || "").toLowerCase();
  const preferred =
    name === "grep" || name === "find" ? args.pattern : undefined;
  const value =
    args.command ??
    preferred ??
    args.file_path ??
    args.path ??
    args.query ??
    args.prompt ??
    args.url ??
    args.file ??
    args.pattern;
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// 技能加载的判定与 pi 宿主保持一致：pi 在 dist/core/tools/renderers/read.js 的
// getCompactReadClassification 里判定 —— 只有 read 工具读取 basename 为 SKILL.md 的文件
// 才算加载技能，大小写敏感，路径字段 file_path 优先于 path，标签取技能目录名。
export function skillLabel(toolName, args) {
  if (String(toolName ?? "").toLowerCase() !== "read") return "";
  if (!args || typeof args !== "object") return "";
  const raw = args.file_path ?? args.path;
  if (typeof raw !== "string" || !raw) return "";
  const segments = raw.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const file = segments.pop() ?? "";
  if (file !== "SKILL.md") return "";
  const parent = segments.pop() ?? "";
  return /^[A-Za-z]:$/.test(parent) ? file : parent || file;
}

export function formatDuration(value, detailed) {
  const total = Math.max(0, Math.round(value || 0));
  if (!detailed && total < 1_000) return "<1s";
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  if (detailed) parts.push(`${milliseconds}ms`);
  return parts.join(" ");
}

const resultContent = (result) => {
  if (!result) return [];
  if (typeof result.content === "string")
    return [h(MarkdownContent, { text: result.content })];
  return (result.content || []).map((block, index) => {
    if (block.type === "text")
      return h(MarkdownContent, { key: index, text: block.text });
    if (block.type === "image")
      return h("p", { key: index, class: "muted" }, "[图片内容]");
    return h("pre", { key: index }, JSON.stringify(block, null, 2));
  });
}

// 工具被中止（bash 被 Esc 打断等）时，宿主会把该工具的结果固定为
// "Operation aborted"（Node 侧则可能是 "This operation was aborted"）。
// 这类情况已由红色「已中断（：原因）」状态提示（横线）表达，
// 工具卡里就不该再单独显示这段文本 —— 保留卡片（含命令/状态），输出置空。
//
// 保留 `isError` 前置条件：只对**错误结果**生效，避免误吞正常输出里的同名文本。
export function isAbortedResult(result) {
  return !!result?.isError && isAbortNotice(resultText(result));
}

// read/bash 的结果是原文（代码内容 / 终端输出），取文本块拼接，
// 不能用 markdown 渲染：终端输出里的 #、*、| 会被改写成标题/列表/表格。
export function resultText(result) {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;
  return (result.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

// read/grep/find/ls 的 INPUT 改成逐项可读参数（原始 JSON 收进「原始 Input」折叠）；
// bash/powershell 的命令改用对应语言的代码块展示（见 toolCommand），其余工具直接展示 JSON。
export function toolInputRows(name, args) {
  const tool = String(name || "").toLowerCase();
  if (!args || typeof args !== "object") return [];
  const rows = [];
  const push = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    rows.push({ label, value: String(value) });
  };
  if (tool === "read") {
    push("路径", toolFilePath(args));
    if (Number.isFinite(Number(args.offset))) push("起始行", args.offset);
    if (Number.isFinite(Number(args.limit))) push("行数", args.limit);
    return rows;
  }
  if (tool === "grep") {
    push("模式", args.pattern);
    push("路径", args.path);
    push("文件过滤", args.glob);
    if (args.ignoreCase === true) push("忽略大小写", "是");
    if (args.literal === true) push("按字面量", "是");
    if (Number(args.context) > 0) push("上下文行数", args.context);
    if (Number.isFinite(Number(args.limit))) push("上限", args.limit);
    return rows;
  }
  if (tool === "find") {
    push("模式", args.pattern);
    push("路径", args.path);
    if (Number.isFinite(Number(args.limit))) push("上限", args.limit);
    return rows;
  }
  if (tool === "ls") {
    push("路径", args.path);
    if (Number.isFinite(Number(args.limit))) push("上限", args.limit);
    return rows;
  }
  return rows;
}

// 结果是一行一行纯文本（终端输出、文件:行号: 内容、路径列表）的工具：
// 这些内容不能过 markdown，否则 #、*、_、| 会被改写成标题/列表/表格。
const PLAIN_OUTPUT_TOOLS = ["bash", "powershell", "grep", "find", "ls"];
export function isPlainOutputTool(name) {
  return PLAIN_OUTPUT_TOOLS.includes(String(name || "").toLowerCase());
}

// bash/powershell 的 INPUT：命令本身就是一个脚本块，按对应语言高亮。
export function toolCommand(name, args) {
  const tool = String(name || "").toLowerCase();
  if (!["bash", "powershell"].includes(tool)) return null;
  const command = args?.command;
  if (typeof command !== "string" || !command) return null;
  return { language: tool, text: command };
}

// read/bash 的结果末尾会带工具自己的提示（如 `[246 more lines in file. Use offset=230 to continue.]`），
// 它们不是代码/终端输出，不能塞进代码块里；抽出来单独当备注展示。
// 只认宿主实际会写的这几种提示头，避免把正文里形如 `[foo]` 的行误判。
const NOTICE_PATTERN =
  /^\[(?:Showing lines|Truncated|Full output|Line \d+ is|File has changed|\d+ more lines)/;
export function splitToolNotices(value) {
  const text = String(value ?? "");
  const marker = text.lastIndexOf("\n\n[");
  if (marker < 0) return { content: text, notices: [] };
  const tail = text.slice(marker + 2).trim();
  if (!tail.startsWith("[") || !tail.endsWith("]"))
    return { content: text, notices: [] };
  // 提示语可能多行（例如指路一句 bash 命令）；以 `[` 开头的行算新一条，其余行归上一条。
  const notices = [];
  for (const raw of tail.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[") || !notices.length) notices.push(line);
    else notices[notices.length - 1] = `${notices.at(-1)}\n${line}`;
  }
  if (!notices.length || !notices.every((notice) => NOTICE_PATTERN.test(notice)))
    return { content: text, notices: [] };
  return { content: text.slice(0, marker), notices };
}

const diffLine = (kind, marker, line, key, lineNumber = "") =>
  h("div", { class: ["diff-line", `diff-${kind}`], key }, [
    // 行号与标记放在同一个 sticky gutter 里：横向滚动时固定在左侧
    h("span", { class: "diff-gutter" }, [
      h("span", { class: "diff-marker" }, marker),
      h("span", { class: "diff-number" }, lineNumber),
    ]),
    h("span", { class: "diff-text" }, line === "" ? " " : line),
  ]);

const lineMarker = (kind) =>
  kind === "added" ? "+" : kind === "removed" ? "-" : " ";

// 折叠块标题左侧的类型图标：工具各用一个独立图标，未知工具用通用方块。
const TOOL_ICONS = {
  bash: "terminal",
  powershell: "terminal",
  read: "file",
  write: "edit",
  edit: "diff",
  grep: "search",
  find: "filter",
  ls: "folder",
};
// 标题里显示的动词（仅本地化 pi 的三个文件工具，其它保持工具原名）
const TOOL_LABELS = { read: "读取", write: "写入", edit: "编辑" };
export function toolLabel(name) {
  const key = String(name || "").toLowerCase();
  return TOOL_LABELS[key] || String(name || "");
}

export function toolIcon(name, skill = false) {
  if (skill) return "spark";
  return TOOL_ICONS[String(name || "").toLowerCase()] || "box";
}

export default defineComponent({
  name: "ToolCallBlock",
  props: {
    call: Object,
    result: Object,
    running: Object,
    timing: Object,
    blockKey: String,
  },
  setup(props) {
    const clock = useConversationClock();
    let clockActive = false,
      resetTimer,
      disposed = false;
    const name = computed(
      () =>
        props.call?.name ||
        props.call?.toolName ||
        props.result?.toolName ||
        props.running?.toolName ||
        "tool",
    );
    const args = computed(
      () => props.call?.arguments ?? props.call?.args ?? props.running?.args,
    );
    const titleArgument = computed(() =>
      toolTitleArgument(args.value, name.value),
    );
    // 读取 SKILL.md 的 read 调用按技能卡片展示（配色与标题都区分开）。
    const skill = computed(() => skillLabel(name.value, args.value));
    const filePath = computed(() => toolFilePath(args.value));
    // pi 系统工具的专门适配：write 直接展示写入内容，edit 展示 -/+ 变更。
    const writeContent = computed(() =>
      String(name.value).toLowerCase() === "write" &&
      typeof args.value?.content === "string"
        ? args.value.content
        : null,
    );
    // write 的写入状态：结果已回来即成功，否则视为正在写入
    const writeStatus = computed(() => (props.result ? "done" : "running"));
    const hunks = computed(() =>
      String(name.value).toLowerCase() === "edit" ? editHunks(args.value) : [],
    );
    // 结果里的真实 diff（带文件行号）优先于参数推算的变更
    const diffLines = computed(() => {
      const diff = props.result?.details?.diff;
      return typeof diff === "string" && diff ? parseToolDiff(diff) : [];
    });
    // read 的结果是文件内容（按路径语言高亮，行号从 offset 开始）
    const readOutput = computed(() =>
      String(name.value).toLowerCase() === "read" &&
      props.result &&
      !props.result.isError
        ? resultText(props.result)
        : null,
    );
    // bash/powershell/grep/find/ls 的结果是逐行文本，原样按 pre 展示
    const plainOutput = computed(() =>
      isPlainOutputTool(name.value) && props.result && !props.result.isError
        ? resultText(props.result)
        : null,
    );
    const inputHtml = computed(() =>
      args.value === undefined
        ? ""
        : codeBlock(JSON.stringify(args.value, null, 2), "json"),
    );
    const startedAt = computed(
      () => props.timing?.startedAt ?? props.running?.startedAt,
    );
    const dynamic = computed(
      () => props.timing?.durationMs == null && startedAt.value != null,
    );
    const elapsed = computed(
      () =>
        props.timing?.durationMs ??
        (startedAt.value == null ? null : clock.now.value - startedAt.value),
    );
    watch(
      dynamic,
      (active) => {
        if (active === clockActive) return;
        clockActive = active;
        active ? clock.start() : clock.stop();
      },
      { immediate: true },
    );
    onUnmounted(() => {
      disposed = true;
      if (clockActive) clock.stop();
      clearTimeout(resetTimer);
    });

    const copyInput = async (event) => {
      const button = event.target.closest?.(".code-copy");
      if (!button) return;
      event.stopPropagation();
      const source =
        button.closest(".code-block")?.querySelector(".code-source code")
          ?.textContent || "";
      clearTimeout(resetTimer);
      try {
        await writeClipboard(source);
        if (disposed || !button.isConnected) return;
        button.dataset.copied = "1";
      } catch {
        if (disposed || !button.isConnected) return;
        button.dataset.failed = "1";
      }
      resetTimer = setTimeout(() => {
        if (!button.isConnected) return;
        delete button.dataset.copied;
        delete button.dataset.failed;
      }, 1500);
    };
    // 专门视图：write 的写入内容 / edit 的变更；原始 JSON 收进二级折叠。
    // read/bash 不做这一套：它们的入参很小（路径/命令），**INPUT 只展示 JSON**，
    // 文件内容与终端输出都归到 OUTPUT。
    // 工具状态行（write/read/edit 共用）：状态词 + 路径 chip（hover 出复制）+ 可选后缀
    const stateLine = (verb, suffix) =>
      h("div", { class: "tool-state-line" }, [
        h("span", null, `${writeStatus.value === "running" ? "正在" : "成功"}${verb}`),
        h(
          "code",
          { class: "path-chip", title: filePath.value },
          [filePath.value],
          filePath.value
            ? h(
                "button",
                { type: "button", class: "chip-copy", "aria-label": "复制路径" },
                "复制",
              )
            : null,
        ),
        suffix || null,
      ]);
    // read 的后缀：从 N 行开始，共 M 行（缺省项省略）
    const readRange = () => {
      const offset = Number(args.value?.offset);
      const limit = Number(args.value?.limit);
      const parts = [];
      if (Number.isFinite(offset) && offset > 0) parts.push(`从 ${offset} 行开始`);
      if (Number.isFinite(limit) && limit > 0) parts.push(`共 ${limit} 行`);
      return parts.length
        ? h("span", { class: "range-hint" }, `（${parts.join("，")}）`)
        : null;
    };
    // edit 的后缀：+新增 绿 / -删除 红（不加粗）
    const diffStat = () => {
      const added = diffLines.value.filter((l) => l.kind === "added").length;
      const removed = diffLines.value.filter((l) => l.kind === "removed").length;
      if (!added && !removed) return null;
      return h("span", { class: "diff-stat" }, [
        added ? h("span", { class: "added" }, `+${added}`) : null,
        removed ? h("span", { class: "removed" }, `-${removed}`) : null,
      ]);
    };
    const dedicated = () => {
      if (writeContent.value != null)
        return h("section", { class: "tool-io-section", onClick: copyInput }, [
          stateLine("写入"),
          h("div", {
            innerHTML: codeBlock(
              writeContent.value,
              languageFromPath(filePath.value),
            ),
          }),
        ]);
      // 结果已经回来时用宿主算好的 diff（带行号）
      if (diffLines.value.length)
        return h("section", { class: "tool-io-section" }, [
          stateLine("编辑", diffStat()),
          h("div", { class: "diff-block" }, [
            h(
              "div",
              { class: "diff-scroll" },
              diffLines.value.map((line, index) =>
                diffLine(
                  line.kind,
                  lineMarker(line.kind),
                  line.content,
                  index,
                  line.lineNumber,
                ),
              ),
            ),
          ]),
        ]);
      if (hunks.value.length)
        return h("section", { class: "tool-io-section" }, [
          stateLine("编辑", diffStat()),
          h("div", { class: "diff-block" }, [
            h(
              "div",
              { class: "diff-scroll" },
              hunks.value.map((hunk, index) =>
                h("div", { class: "diff-hunk", key: index }, [
                  ...hunk.oldLines.map((line, position) =>
                    diffLine("removed", "-", line, `o${position}`),
                  ),
                  ...hunk.newLines.map((line, position) =>
                    diffLine("added", "+", line, `n${position}`),
                  ),
                ]),
              ),
            ),
          ]),
        ]);
      return null;
    };
    const rawInput = () =>
      args.value === undefined
        ? null
        : h("details", { class: "tool-raw-input" }, [
            h("summary", "原始 Input"),
            h("div", { class: "tool-io-section", onClick: copyInput }, [
              h("div", { innerHTML: inputHtml.value }),
            ]),
          ]);
    // read/bash：可读参数行 + 原始 JSON 折叠；其余工具保持直接展示 JSON
    const paramsSection = () =>
      h("section", { class: "tool-io-section" }, [
        h(
          "dl",
          { class: "tool-params" },
          params.value.flatMap((row) => [
            h("dt", { key: `${row.label}-label` }, row.label),
            h("dd", { key: `${row.label}-value` }, row.value),
          ]),
        ),
        rawInput(),
      ]);
    const jsonSection = () =>
      h("section", { class: "tool-io-section", onClick: copyInput }, [
        h("div", { innerHTML: inputHtml.value }),
      ]);
    // bash/powershell：命令直接当脚本块高亮，原始 JSON 同样收进折叠
    const commandSection = () =>
      h("section", { class: "tool-io-section", onClick: copyInput }, [
        h("div", {
          innerHTML: codeBlock(command.value.text, command.value.language),
        }),
        rawInput(),
      ]);
    const params = computed(() => toolInputRows(name.value, args.value));
    const command = computed(() => toolCommand(name.value, args.value));
    // 没有专用视图的工具直接展示 JSON Input + Markdown Output。
    // 通用形态的输入区：bash/powershell 用对应语言的代码块展示命令，
    // 其余工具用 JSON。两者都放在同一个透明边框盒子里，与输出以分割线分开。
    const genericInput = () =>
      command.value
        ? h("section", { class: "tool-io-section", onClick: copyInput }, [
            h("div", {
              innerHTML: codeBlock(command.value.text, command.value.language),
            }),
          ])
        : jsonSection();
    // 采用「通用形态」（透明边框盒子）的工具：没有专用视图的工具，以及 bash/powershell。
    // 盒子形态：bash/powershell（命令代码块）以及没有专用视图的通用工具；
    // 有专用视图的（write 内容、edit 变更、read/grep/find/ls 参数行）不走盒子。
    const boxedTool = computed(
      () =>
        args.value !== undefined &&
        !writeContent.value &&
        !hunks.value.length &&
        !diffLines.value.length &&
        !params.value.length,
    );
    const genericOutput = () => {
      let body = null;
      if (props.result) {
        if (isAbortedResult(props.result)) return null;
        body = resultContent(props.result);
      } else if (props.running?.partialResult !== undefined)
        body = [h(MarkdownContent, { text: text(props.running.partialResult) })];
      return h("section", { class: "tool-io-section tool-output-markdown" }, [
        h("div", { class: "tool-io-label" }, "Output"),
        body || h("p", { class: "tool-waiting" }, "等待输出…"),
      ]);
    };
    const output = () => {
      // read：按路径语言高亮展示文件内容（行号从 offset 开始；工具提示语不进代码块）
      // read：状态行（正在/成功读取 + 路径 + 范围）+ 代码块 + 工具提示语
      if (readOutput.value != null) {
        const { content, notices } = splitToolNotices(readOutput.value);
        return h(
          "section",
          { class: "tool-io-section", onClick: copyInput },
          [
            stateLine("读取", readRange()),
            h("div", { class: "tool-read-code" }, [
            h("div", {
              innerHTML: codeBlock(
                content,
                languageFromPath(filePath.value),
                { startLine: Number(args.value?.offset) || 1 },
              ),
            }),
            notices.length
                ? h(
                    "ul",
                    { class: "tool-notices" },
                    notices.map((notice, index) =>
                      h("li", { key: index }, notice),
                    ),
                  )
                : null,
              ]),
          ],
        );
      }
      // bash/powershell/grep/find/ls：逐行文本原样展示，可换行但不走 markdown
      if (plainOutput.value != null) {
        const { content, notices } = splitToolNotices(plainOutput.value);
        return h("div", { class: "tool-output-frame" }, [
          content ? h("pre", { class: "plain-output" }, content) : null,
          notices.length
            ? h(
                "ul",
                { class: "tool-notices" },
                notices.map((notice, index) => h("li", { key: index }, notice)),
              )
            : null,
        ]);
      }
      if (props.result)
        return isAbortedResult(props.result)
          ? null
          : h(
              "div",
              { class: "tool-output-frame" },
              resultContent(props.result),
            );
      if (props.running?.partialResult !== undefined)
        return h("div", { class: "tool-output-frame" }, [
          h("pre", text(props.running.partialResult)),
        ]);
      return null;
    };

    return () => {
      const status = props.result
        ? props.result.isError
          ? "failure"
          : "success"
        : "running";
      const outputNode = output();
      const dedicatedNode = dedicated();
      return h(
        DisclosureBlock,
        {
          class: [
            "tool-block",
            `tool-${status}`,
            // 折叠块的两种状态：正常=灰、报错=红（整行含图标/标题/摘要）
            status === "failure" && "is-error",
            skill.value && "tool-skill",
            boxedTool.value && "tool-generic",
            command.value && "tool-shell",
          ],
          blockKey: props.blockKey,
          icon: toolIcon(name.value, Boolean(skill.value)),
        },
        {
          summary: () => [
            h("span", { class: "tool-title" }, [
              h("strong", skill.value ? "skill" : toolLabel(name.value)),
              (skill.value || titleArgument.value) &&
                h("span", { class: "disclosure-separator" }, "·"),
              (skill.value || titleArgument.value) &&
                h("span", skill.value || titleArgument.value),
            ]),
            h(
              "span",
              { class: "tool-duration" },
              elapsed.value == null
                ? "--"
                : [
                    h(
                      "span",
                      { class: "duration-collapsed" },
                      formatDuration(elapsed.value, false),
                    ),
                    h(
                      "span",
                      { class: "duration-expanded" },
                      formatDuration(elapsed.value, true),
                    ),
                  ],
            ),
          ],
          default: () => [h("div", { class: "tool-body" }, [
            // 通用形态：输入（bash 命令块 / JSON）+ 输出，用透明边框盒子包住，中间一条分割线。
            boxedTool.value
              ? [
                  h("div", { class: "tool-generic-box" }, [
                    genericInput(),
                    genericOutput(),
                  ]),
                ]
              : [
                  // read/write/edit 用「状态行 + 内容」的专用视图（read 也不再展示原始参数）；
                  // 其余工具按形态展示：shell 用命令块，其它用 JSON
                  dedicatedNode ??
                    (args.value !== undefined &&
                      (command.value ? commandSection() : jsonSection())),
                  // 专用视图不再显示「原始 Input」：路径、范围与变更都已完整展示
                  dedicatedNode &&
                    !writeContent.value &&
                    !params.value.length &&
                    !diffLines.value.length &&
                    !hunks.value.length &&
                    rawInput(),
                  outputNode && !writeContent.value && !diffLines.value.length && !hunks.value.length &&
                    h("section", { class: "tool-io-section" }, [
                                    outputNode,
                    ]),
                  !outputNode &&
                    status === "running" &&
                    h("p", { class: "tool-waiting" }, "等待输出…"),
                ],
          ])],
        },
      );
    };
  },
});
