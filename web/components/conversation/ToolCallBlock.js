import { computed, defineComponent, h, onUnmounted, watch } from "vue";
import { writeClipboard } from "../../clipboard.js";
import { codeBlock } from "../../markdown.js";
import { useConversationClock } from "../../stores/conversation.js";
import MarkdownContent from "./MarkdownContent.js";
import DisclosureBlock from "./DisclosureBlock.js";

const text = (value) =>
  typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);

export function toolTitleArgument(args) {
  if (!args || typeof args !== "object") return "";
  const value =
    args.command ??
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

function resultContent(result) {
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
    const output = () => {
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
            args.value !== undefined &&
              h("section", { class: "tool-io-section", onClick: copyInput }, [
                h("div", { class: "tool-io-label" }, "Input"),
                h("div", { innerHTML: inputHtml.value }),
              ]),
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
