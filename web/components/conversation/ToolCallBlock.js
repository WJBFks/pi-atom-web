import { computed, defineComponent, h, onUnmounted, watch } from "vue";
import { writeClipboard } from "../../clipboard.js";
import { codeBlock } from "../../markdown.js";
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

export function toolTitleArgument(args) {
  if (!args || typeof args !== "object") return "";
  const value =
    args.command ??
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

// read 的 INPUT 改成逐项可读参数（路径/起始行/行数），原始 JSON 收进「原始 Input」折叠；
// bash/powershell 的命令改用对应语言的代码块展示（见 toolCommand），其余工具直接展示 JSON。
export function toolInputRows(name, args) {
  if (String(name || "").toLowerCase() !== "read") return [];
  if (!args || typeof args !== "object") return [];
  const rows = [];
  const path = toolFilePath(args);
  if (path) rows.push({ label: "路径", value: path });
  if (Number.isFinite(Number(args.offset)))
    rows.push({ label: "起始行", value: String(args.offset) });
  if (Number.isFinite(Number(args.limit)))
    rows.push({ label: "行数", value: String(args.limit) });
  return rows;
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
  const lines = text
    .slice(marker + 2)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || !lines.every((line) => NOTICE_PATTERN.test(line)))
    return { content: text, notices: [] };
  return { content: text.slice(0, marker), notices: lines };
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
    const titleArgument = computed(() => toolTitleArgument(args.value));
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
    // bash/powershell 的结果是终端输出，原样按 pre 展示
    const shellOutput = computed(() =>
      ["bash", "powershell"].includes(String(name.value).toLowerCase()) &&
      props.result &&
      !props.result.isError
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
        button.textContent = "已复制";
      } catch {
        if (disposed || !button.isConnected) return;
        button.textContent = "复制失败";
      }
      resetTimer = setTimeout(() => {
        if (button.isConnected) button.textContent = "复制";
      }, 1500);
    };
    // 专门视图：write 的写入内容 / edit 的变更；原始 JSON 收进二级折叠。
    // read/bash 不做这一套：它们的入参很小（路径/命令），**INPUT 只展示 JSON**，
    // 文件内容与终端输出都归到 OUTPUT。
    const dedicated = () => {
      if (writeContent.value != null)
        return h("section", { class: "tool-io-section", onClick: copyInput }, [
          h("div", { class: "tool-io-label" }, "文件内容"),
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
          h("div", { class: "tool-io-label" }, "变更"),
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
          h("div", { class: "tool-io-label" }, "变更"),
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
        h("div", { class: "tool-io-label" }, "Input"),
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
        h("div", { class: "tool-io-label" }, "Input"),
        h("div", { innerHTML: inputHtml.value }),
      ]);
    // bash/powershell：命令直接当脚本块高亮，原始 JSON 同样收进折叠
    const commandSection = () =>
      h("section", { class: "tool-io-section", onClick: copyInput }, [
        h("div", { class: "tool-io-label" }, "Input"),
        h("div", {
          innerHTML: codeBlock(command.value.text, command.value.language),
        }),
        rawInput(),
      ]);
    const params = computed(() => toolInputRows(name.value, args.value));
    const command = computed(() => toolCommand(name.value, args.value));
    const output = () => {
      // read：按路径语言高亮展示文件内容（行号从 offset 开始；工具提示语不进代码块）
      if (readOutput.value != null) {
        const { content, notices } = splitToolNotices(readOutput.value);
        return h(
          "div",
          { class: "tool-output-frame", onClick: copyInput },
          [
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
          ],
        );
      }
      // bash/powershell：终端输出原样展示，可换行但不走 markdown
      if (shellOutput.value != null) {
        const { content, notices } = splitToolNotices(shellOutput.value);
        return h("div", { class: "tool-output-frame" }, [
          content ? h("pre", { class: "shell-output" }, content) : null,
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
        return h(
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
          class: ["tool-block", `tool-${status}`, skill.value && "tool-skill"],
          blockKey: props.blockKey,
        },
        {
          summary: () => [
            h("span", { class: "tool-title" }, [
              h("strong", skill.value ? "skill" : name.value),
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
            dedicatedNode ??
              (args.value !== undefined &&
                (params.value.length
                  ? paramsSection()
                  : command.value
                    ? commandSection()
                    : jsonSection())),
            dedicatedNode && rawInput(),
            outputNode &&
              h("section", { class: "tool-io-section" }, [
                h("div", { class: "tool-io-label" }, "Output"),
                outputNode,
              ]),
            !outputNode &&
              status === "running" &&
              h("p", { class: "tool-waiting" }, "等待输出…"),
          ])],
        },
      );
    };
  },
});
