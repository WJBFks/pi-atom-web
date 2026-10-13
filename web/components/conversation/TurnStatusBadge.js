import { defineComponent, h, onUnmounted, ref } from "vue";
import { icon } from "../../icons.js";
import { writeClipboard } from "../../clipboard.js";
import { contentBlocks } from "../../stores/conversation.js";
import { formatProcessingDuration, IconTipButton } from "./ProcessingStatus.js";
import { useHoverTip } from "./hover-tip.js";

const pad = (value) => String(value).padStart(2, "0");

/** `17:07` —— 轮次完成时刻（时:分）。 */
export function formatClockTime(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `2026-09-18 17:07:17` —— hover 浮层里的完整时间戳。 */
export function formatFullTime(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 从消息里取最终输出的完整文本：所有 text 块原文按空行拼接；字符串内容原样返回。 */
export function finalOutputText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/**
 * 已完成轮次的状态徽标：`17:07（耗时2分钟48秒） [复制]`。
 * - 时间 = 完成时刻（turnProcessing 的 startedAt + durationMs）；
 * - hover 时间文字弹三行浮层（开始时间 / 结束时间 / 总耗时，浮层由 `useHoverTip` 挂到 body）；
 * - 复制按钮把最终输出文本完整复制（反馈沿用惯例：图标短暂变对勾，不显示文字）。
 * 渲染在 `<article class="message">` 内、`.body` 之后（见 MessageItem 的 status 插槽）。
 */
export default defineComponent({
  name: "TurnStatusBadge",
  props: {
    message: { type: Object, required: true },
    completedAt: { type: Number, required: true },
    durationMs: { type: Number, required: true },
  },
  setup(props) {
    const copied = ref(false);
    const failed = ref(false);
    // 浮层一律走 PortalTip（见 hover-tip.js）：留在正文里会被三级吸顶标题压住、
    // 被折叠块的 overflow:clip 裁掉。
    const { anchor: timeEl, show, hide, tip } = useHoverTip();
    let copyTimer, failTimer;
    const copy = async () => {
      const text = finalOutputText(props.message);
      if (text.trim() === "") return;
      try {
        await writeClipboard(text);
        copied.value = true;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => (copied.value = false), 1200);
      } catch {
        // 两条复制路径都失败时给出可见反馈，不能静默（用户点不动会以为是坏了）。
        failed.value = true;
        clearTimeout(failTimer);
        failTimer = setTimeout(() => (failed.value = false), 2000);
      }
    };
    onUnmounted(() => {
      clearTimeout(copyTimer);
      clearTimeout(failTimer);
    });
    return () => {
      const hasText = finalOutputText(props.message).trim() !== "";
      return h(
        "div",
        { class: "processing-status is-done turn-status" },
        [
          h(
            "span",
            {
              class: "turn-status-time",
              ref: timeEl,
              onMouseenter: show,
              onMouseleave: hide,
            },
            [
              `${formatClockTime(props.completedAt)}（耗时${formatProcessingDuration(props.durationMs)}）`,
              tip([
                h("span", `开始时间：${formatFullTime(props.completedAt - props.durationMs)}`),
                h("span", `结束时间：${formatFullTime(props.completedAt)}`),
                h("span", `总耗时：${formatProcessingDuration(props.durationMs)}`),
              ]),
            ],
          ),
          hasText
            ? [
                h(
                  IconTipButton,
                  {
                    iconName: copied.value ? "check" : "copy",
                    label: copied.value ? "已复制" : "复制消息",
                    placement: "top",
                    class: "turn-status-copy",
                    onClick: copy,
                  },
                ),
                failed.value
                  ? h("span", { class: "turn-status-copy-failed" }, "复制失败")
                  : null,
              ]
            : null,
        ],
      );
    };
  },
});
