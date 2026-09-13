import { Teleport, defineComponent, h, nextTick, onMounted, onUnmounted, ref } from "vue";
import { icon } from "../../icons.js";
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

export const PreviewImage = defineComponent({
  name: "PreviewImage",
  props: {
    src: { type: String, required: true },
    alt: { type: String, default: "图片" },
    imageClass: String,
  },
  setup(props) {
    const open = ref(false), closeButton = ref(), trigger = ref();
    const close = () => {
      open.value = false;
      nextTick(() => trigger.value?.focus());
    };
    const show = () => {
      open.value = true;
      nextTick(() => closeButton.value?.focus());
    };
    const keydown = (event) => {
      if (open.value && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    onMounted(() => document.addEventListener("keydown", keydown));
    onUnmounted(() => document.removeEventListener("keydown", keydown));
    return () => [
      h("button", {
        ref: trigger,
        type: "button",
        class: "image-preview-trigger",
        "aria-label": `预览${props.alt}`,
        "aria-haspopup": "dialog",
        onClick: show,
      }, h("img", { class: props.imageClass, src: props.src, alt: props.alt })),
      open.value
        ? h(Teleport, { to: "body" }, h("div", {
            class: "image-preview-overlay",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": props.alt,
            onClick: close,
          }, [
            h("img", {
              class: "image-preview-full",
              src: props.src,
              alt: props.alt,
              onClick: (event) => event.stopPropagation(),
            }),
            h("button", {
              ref: closeButton,
              type: "button",
              class: "image-preview-close",
              "aria-label": "关闭图片预览",
              onClick: close,
            }, icon("close")),
          ]))
        : null,
    ];
  },
});

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

      const rawBlocks = contentBlocks(message.content);
      const userImages =
        message.role === "user"
          ? rawBlocks.filter((block) => block.type === "image")
          : [];
      const renderImage = (block, index) =>
        h(PreviewImage, {
          key: `image-${index}`,
          imageClass: "message-image",
          src: `data:${block.mimeType};base64,${block.data}`,
          alt: `用户上传的图片 ${index + 1}`,
        });
      const blocks =
        typeof message.content === "string"
          ? [h(MarkdownContent, { text: message.content, live: props.live })]
          : rawBlocks.map((block, index) => {
              if (message.role === "user" && block.type === "image") return null;
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
                return renderImage(block, index);
              return null;
            }).filter(Boolean);
      if (message.role === "user" && userImages.length)
        return h("article", { class: ["message", "user", "user-with-images"] }, [
          h(
            "div",
            { class: "user-image-strip", "aria-label": "用户上传的图片" },
            userImages.map(renderImage),
          ),
          blocks.length ? h("div", { class: "body user-bubble" }, blocks) : null,
          message.errorMessage && h("p", { class: "failure" }, message.errorMessage),
        ]);
      return h(
        "article",
        { class: ["message", message.role === "user" && "user"] },
        [
          message.role === "user" || message.role === "assistant"
            ? null
            : h("div", { class: "role" }, message.role),
          h("div", { class: "body" }, blocks),
          message.errorMessage &&
            h("p", { class: "failure" }, message.errorMessage),
        ],
      );
    };
  },
});
