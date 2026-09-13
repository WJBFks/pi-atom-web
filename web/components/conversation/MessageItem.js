import { defineComponent, h, ref } from "vue";
import {
  contentBlocks,
  messageId,
  toolCallId,
  toolResultId,
} from "../../stores/conversation.js";
import MarkdownContent from "./MarkdownContent.js";
import ThinkingBlock from "./ThinkingBlock.js";
import ToolCallBlock from "./ToolCallBlock.js";
import DisclosureBlock from "./DisclosureBlock.js";
import CustomEntryBlock from "./CustomEntryBlock.js";

const emptyTools = () => ({
  calls: new Map(),
  results: new Map(),
  running: new Map(),
  timings: new Map(),
});

export default defineComponent({
  name: "MessageItem",
  props: {
    message: { type: Object, required: true },
    live: Boolean,
    tools: Object,
  },
  setup(props) {
    const bashOpen = ref(false);
    return () => {
      const message = props.message;
      const tools = props.tools || emptyTools();
      const key = messageId(message);
      if (message.role === "custom" && message.display === false) return null;
      if (
        message.role === "branchSummary" ||
        message.role === "compactionSummary"
      ) {
        return h("article", { class: "message" }, [
          h(
            "div",
            { class: "role" },
            message.role === "branchSummary" ? "分支摘要" : "上下文摘要",
          ),
          h(MarkdownContent, { text: message.summary || "" }),
        ]);
      }
      if (message.role === "customEntry")
        return h(CustomEntryBlock, { message });
      if (message.role === "notification") {
        const level = message.level || "info";
        const content = String(message.content || "");
        const preview = content.replace(/\s+/g, " ").trim();
        return h(
          DisclosureBlock,
          {
            class: ["notification-block", `notification-${level}`],
            blockKey: key,
            "data-notification": level,
          },
          {
            summary: () => [
              h("span", { class: "disclosure-summary-row" }, [
                h("strong", "TUI 通知"),
                h("span", { class: "disclosure-meta" }, level),
                h("span", { class: "disclosure-preview" }, preview),
              ]),
            ],
            default: () => [
              h("div", { class: "notification-text" }, content),
            ],
          },
        );
      }
      if (message.role === "command") {
        return h(
          "article",
          { class: ["message", "user"] },
          [
            h("div", { class: "role" }, "命令"),
            h(
              "div",
              { class: "notification-text" },
              String(message.content || ""),
            ),
          ],
        );
      }
      if (message.role === "toolResult") {
        const id = toolResultId(message);
        if (id != null && tools.calls.has(String(id))) return null;
        return h(ToolCallBlock, {
          result: message,
          timing: id == null ? undefined : tools.timings.get(String(id)),
          blockKey: id == null ? `result-${key}` : `tool-${id}`,
        });
      }
      if (message.role === "bashExecution") {
        return h(
          "details",
          {
            "data-key": key,
            open: bashOpen.value,
            onToggle: (event) => {
              bashOpen.value = event.currentTarget.open;
            },
          },
          [
            h("summary", `终端 · ${message.command || ""}`),
            h("pre", String(message.output || "")),
          ],
        );
      }

      const blocks =
        typeof message.content === "string"
          ? [h(MarkdownContent, { text: message.content, live: props.live })]
          : contentBlocks(message.content).map((block, index) => {
              if (block.type === "text")
                return h(MarkdownContent, {
                  key: index,
                  text: block.text,
                  live: props.live,
                });
              if (block.type === "thinking")
                return h(ThinkingBlock, {
                  key: index,
                  text: block.thinking,
                  blockKey: `${key}-thinking-${index}`,
                  running: props.live,
                });
              if (block.type === "toolCall") {
                const id = toolCallId(block);
                const toolKey =
                  id == null ? `${key}-call-${index}` : String(id);
                return h(ToolCallBlock, {
                  key: toolKey,
                  call: block,
                  result:
                    id == null ? undefined : tools.results.get(String(id)),
                  running:
                    id == null ? undefined : tools.running.get(String(id)),
                  timing:
                    id == null ? undefined : tools.timings.get(String(id)),
                  blockKey: id == null ? toolKey : `tool-${id}`,
                });
              }
              if (block.type === "image")
                return h("p", { key: index, class: "muted" }, "[图片内容]");
              return null;
            });
      return h(
        "article",
        { class: ["message", message.role === "user" && "user"] },
        [
          message.role === "user"
            ? null
            : h(
                "div",
                { class: "role" },
                message.role === "assistant" ? "pi" : message.role,
              ),
          h("div", { class: "body" }, blocks),
          message.errorMessage &&
            h("p", { class: "failure" }, message.errorMessage),
        ],
      );
    };
  },
});
