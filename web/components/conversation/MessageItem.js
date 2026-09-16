import { Teleport, defineComponent, h, nextTick, onMounted, onUnmounted, ref } from "vue";
import { icon } from "../../icons.js";
import {
  contentBlocks,
  lastThinkingIndex,
  messageId,
  toolCallId,
  toolResultId,
} from "../../stores/conversation.js";
import MarkdownContent from "./MarkdownContent.js";
import ThinkingBlock from "./ThinkingBlock.js";
import ToolCallBlock from "./ToolCallBlock.js";
import DisclosureBlock from "./DisclosureBlock.js";
import CustomEntryBlock from "./CustomEntryBlock.js";
import { isAbortNotice } from "./abort-notice.js";
import { writeClipboard } from "../../clipboard.js";

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

/**
 * 命令名：从完整命令里取出第一个词（`/piolium-help --fresh` → `/piolium-help`）。
 * 非 `/` 开头的原样返回。
 */
export function stripCommandPrefix(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return value;
  return value.split(/\s+/)[0] || value;
}

/**
 * 横线样式的行内条目标记（内部称「状态提示」）：命令 / 模型被终止 / 模型与思考级别变更共用。
 *
 * 外观：一条贯穿的分割线，文字居中压在线上（`-----命令：/piolium-help-----` 的观感）。
 * 线用 CSS 画（左右两段 1px 线 + 中间文字），不是减号字符拼接，宽度自适应。
 *
 * · `label` 是主文案；`code` 是其中要用行内代码样式呈现的部分（可为空）。
 * · 命令默认只显示命令名；圆圈感叹号 hover 弹自定义浮层（两行：全文 / 点击复制），
 *   不用系统 title —— 系统提示样式不可控、且有延迟。
 * · 点击气泡复制，复制后有「已复制」反馈。
 */
export const CommandRule = defineComponent({
  name: "CommandRule",
  props: {
    label: { type: String, required: true },
    code: { type: String, default: "" },
    full: { type: String, default: "" },
    /** 浮层里的第二行提示（中英双语等），默认「点击复制」。 */
    hint: { type: String, default: "点击复制" },
    kind: { type: String, default: "command" },
    blockKey: { type: String, default: "" },
  },
  setup(props) {
    const copied = ref(false);
    const open = ref(false);
    const root = ref();
    let hideTimer = null;
    const show = () => {
      clearTimeout(hideTimer);
      open.value = true;
    };
    // 延迟一点再收起：鼠标从气泡移到弹层途中有间隙，立刻收起会闪
    const hide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => (open.value = false), 120);
    };
    const source = () => props.full || props.code || props.label;
    const copy = async () => {
      try {
        await writeClipboard(source());
        copied.value = true;
        setTimeout(() => (copied.value = false), 1200);
      } catch {
        copied.value = false;
      }
    };
    onUnmounted(() => clearTimeout(hideTimer));
    return () =>
      h(
        "div",
        {
          class: ["command-rule", `command-rule-${props.kind}`],
          "data-command-rule": props.kind,
          "data-key": props.blockKey,
          ref: root,
        },
        [
          // 一条贯穿整宽的分割线（绝对定位，起止点与其它条目完全一致，
          // 不随文字长短变化），文字居中压在线上并用底色遮断中间那段。
          h("span", { class: "command-rule-line", "aria-hidden": "true" }),
          h("span", { class: "command-rule-body" }, [
            h("span", { class: "command-rule-label" }, props.label),
            // 命令名用行内代码样式（仅限状态栏/hover 之外的主文案）
            props.code ? h("code", { class: "command-rule-code" }, props.code) : null,
            h(
              "span",
              {
                class: "command-rule-info-wrap",
                onMouseenter: show,
                onMouseleave: hide,
                onFocusin: show,
                onFocusout: hide,
              },
              [
                h(
                  "button",
                  {
                    type: "button",
                    class: "command-rule-info",
                    "aria-label": copied.value ? "已复制" : `复制：${source()}`,
                    "aria-expanded": String(open.value),
                    onClick: copy,
                  },
                  icon(copied.value ? "check" : "alert"),
                ),
                // 自定义浮层：两行 —— 第一行全文，第二行点击复制
                open.value
                  ? h("span", { class: "command-rule-tip", role: "tooltip" }, [
                      h("span", { class: "command-rule-tip-full" }, source()),
                      // 第二行固定显示操作提示（复制反馈只体现在图标变对勾上，
                      // 不再把文案换成「已复制」）
                      h("span", { class: "command-rule-tip-hint" }, props.hint),
                    ])
                  : null,
              ],
            ),
          ]),
          // 右侧那一段线：与左侧等分剩余空间，文字因此居中。
          // （曾改成单条绝对定位整宽线时把它删掉过，恢复布局时必须补回来，
          //   否则只剩左线、文字会被挤到最右。）
          h("span", { class: "command-rule-line", "aria-hidden": "true" }),
        ],
      );
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
            class: [
              "notification-block",
              `notification-${level}`,
              // 通知按级别落状态：warning=橙、error=红（整行含图标/标题/摘要），info=正常灰
              level === "warning" && "is-warning",
              level === "error" && "is-error",
            ],
            blockKey: key,
            "data-notification": level,
            // 图标与标题、摘要同色：info 灰、warning 橙、error 红
            icon: "bell",
          },
          {
            summary: () => [
              h("span", { class: "disclosure-summary-row" }, [
                h("strong", "通知"),
                h("span", { class: "disclosure-separator" }, "·"),
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
        // 只展示命令名；完整命令（含参数）放 hover 浮层，点击可复制。
        const full = String(message.content || "");
        return h(CommandRule, {
          label: "命令：",
          code: stripCommandPrefix(full),
          full,
          kind: "command",
          blockKey: key,
        });
      }
      if (message.role === "status") {
        // 状态提示：模型 / 思考级别变更（发 prompt 前插入，说明这轮是在什么配置下跑的）。
        // 文案里用反引号标出要用行内代码样式呈现的部分（如 `DeepSeek V4.1 Flash · high`）。
        const raw = String(message.content || "");
        const match = /`([^`]*)`/.exec(raw);
        return h(CommandRule, {
          label: match ? raw.slice(0, match.index) : raw,
          code: match ? match[1] : "",
          full: raw.replace(/`/g, ""),
          kind: "status",
          blockKey: key,
        });
      }
      if (message.role === "interrupted") {
        // 被中止：工具级的 aborted 归入这一类，统一用红横线
        return h(CommandRule, {
          label: String(message.content || "已中断"),
          full: String(message.detail || message.content || ""),
          hint: String(message.hint || "点击复制"),
          kind: "interrupted",
          blockKey: key,
        });
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
      const thinkingLastIndex = lastThinkingIndex(message.content);
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
                  // 只有最后一个思考块在仍生成时保持展开；下一个思考块一开始，
                  // 前一个立刻折叠，整段回话结束时（消息离开 live 区）全部折叠。
                  running: props.live && index === thinkingLastIndex,
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
          message.errorMessage &&
            !isAbortNotice(message.errorMessage) &&
            h("p", { class: "failure" }, message.errorMessage),
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
            !isAbortNotice(message.errorMessage) &&
            h("p", { class: "failure" }, message.errorMessage),
        ],
      );
    };
  },
});
