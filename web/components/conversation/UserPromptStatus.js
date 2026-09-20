import { defineComponent, h, onUnmounted, ref } from "vue";
import { icon } from "../../icons.js";
import { postAction } from "../../api/actions.js";
import { writeClipboard } from "../../clipboard.js";
import { contentBlocks, useConversationStore } from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import { formatFullTime, IconTipButton } from "./ProcessingStatus.js";

const pad = (value) => String(value).padStart(2, "0");

/** `18:09` —— 用户提示词发出时刻（时:分）。 */
export function formatClockTime(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 用户提示词的原文纯文本：所有 text 块按空行拼接；字符串内容原样返回（图片不参与复制）。 */
export function promptText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/**
 * 普通用户消息下方右对齐的状态行：`[编辑] [复制] < 2/2 > 18:09`。
 * - 时间 = 该消息 entry 的时间戳（本地 HH:MM），hover 弹完整时间戳（.status-tip）；
 * - `< x/y >` 仅在该用户消息存在兄弟分支（同一父节点下的平行会话）时显示，
 *   首/末分支分别禁用 `<` / `>`，切换走 `navigate_branch`（服务端导航到该分支末端）；
 * - 编辑按钮进入原位编辑（气泡就地变为编辑框，见 MessageItem）；
 * - 编辑/复制按钮平时隐藏，hover 整条用户消息时淡入（CSS 控制）；
 * - 复制沿用惯例：图标短暂变对勾，两条路径都失败时显示「复制失败」。
 * 渲染在 `<article class="message user">` 内、气泡（.body）之后，随消息一起滚动。
 */
export default defineComponent({
  name: "UserPromptStatus",
  props: {
    message: { type: Object, required: true },
    token: { type: String, default: "" },
    onError: { type: Function, default: null },
  },
  setup(props) {
    const conversation = useConversationStore();
    const session = useSessionStore();
    const copied = ref(false);
    const failed = ref(false);
    const open = ref(false);
    const switching = ref(false);
    let hideTimer, copyTimer, failTimer;

    const show = () => {
      clearTimeout(hideTimer);
      open.value = true;
    };
    const hide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => (open.value = false), 120);
    };
    const report = (error) => props.onError?.(error?.message || String(error));
    const copy = async () => {
      const text = promptText(props.message);
      if (!text.trim()) return;
      try {
        await writeClipboard(text);
        copied.value = true;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => (copied.value = false), 1200);
      } catch {
        failed.value = true;
        clearTimeout(failTimer);
        failTimer = setTimeout(() => (failed.value = false), 2000);
      }
    };
    const edit = () =>
      conversation.beginUserEdit(props.message.id, promptText(props.message));
    const go = async (entryId) => {
      if (!entryId || switching.value) return;
      switching.value = true;
      try {
        await postAction(props.token, {
          type: "navigate_branch",
          sessionId: session.sessionId,
          entryId,
        });
      } catch (error) {
        report(error);
      } finally {
        switching.value = false;
      }
    };
    onUnmounted(() => {
      clearTimeout(hideTimer);
      clearTimeout(copyTimer);
      clearTimeout(failTimer);
    });

    return () => {
      const message = props.message;
      // 正在重开该轮：整行让位给提示。
      if (conversation.restarting && conversation.restartingId === message.id)
        return h("div", { class: "user-prompt processing-status" }, [
          h("span", { class: "user-prompt-restarting" }, "正在重启该轮…"),
        ]);
      const branch = message.branch || null;
      const timestamp = Number.isFinite(message.timestamp)
        ? message.timestamp
        : null;
      const item = (name, options) =>
        h(IconTipButton, {
          iconName: name,
          class: "user-prompt-action",
          ...options,
        });
      return h("div", { class: "user-prompt processing-status" }, [
        h("span", { class: "user-prompt-actions" }, [
          item("edit", {
            label: "修改消息",
            onClick: edit,
          }),
          item(copied.value ? "check" : "copy", {
            label: copied.value ? "已复制" : "复制消息",
            onClick: copy,
          }),
          failed.value
            ? h("span", { class: "user-prompt-copy-failed" }, "复制失败")
            : null,
        ]),
        branch
          ? h("span", { class: "user-prompt-branch" }, [
              h(IconTipButton, {
                iconName: "chevron-left",
                class: "user-prompt-branch-step",
                label: "上一条会话",
                disabled: !branch.prev,
                onClick: () => go(branch.prev),
              }),
              h("span", { class: "user-prompt-branch-count" }, `${branch.index}/${branch.count}`),
              h(IconTipButton, {
                iconName: "chevron-right",
                class: "user-prompt-branch-step",
                label: "下一条会话",
                disabled: !branch.next,
                onClick: () => go(branch.next),
              }),
            ])
          : null,
        timestamp == null
          ? null
          : h(
              "span",
              {
                class: "user-prompt-time",
                onMouseenter: show,
                onMouseleave: hide,
              },
              [
                formatClockTime(timestamp),
                open.value
                  ? h(
                      "span",
                      { class: "status-tip", role: "tooltip" },
                      formatFullTime(timestamp),
                    )
                  : null,
              ],
            ),
      ]);
    };
  },
});
