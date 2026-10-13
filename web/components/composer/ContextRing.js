import { computed, defineComponent, h } from "vue";
import { useSessionStore } from "../../stores/session.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useComposerStore } from "../../stores/composer.js";
import { postAction } from "../../api/actions.js";
import { icon } from "../../icons.js";
import DetailRows from "../status/DetailRows.js";
import { contextUsageView } from "../status/format.js";

// 环的几何：viewBox 18×18、半径 7、线宽 3（与 16px 图标同一档尺寸）。
// 底图是一整圈，用量从 12 点方向顺时针覆盖 —— 与浏览器标签页/系统进度环同一读法。
const RADIUS = 7,
  CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default defineComponent({
  name: "ContextRing",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore(),
      conversation = useConversationStore(),
      composer = useComposerStore();
    const view = computed(() => contextUsageView(session));
    const open = computed(() => composer.popover === "context");
    // 与模型/思考级别选择器互斥：打开环就收起选择器（选择器那边已经会清 popover）。
    const toggle = () => {
      composer.picker = null;
      composer.popover = open.value ? null : "context";
    };
    const compact = async () => {
      composer.popover = null;
      try {
        await postAction(props.token, {
          type: "send",
          sessionId: session.sessionId,
          text: "/compact",
          images: [],
          mode: "followUp",
        });
      } catch (error) {
        props.onError?.(error);
      }
    };
    const arc = (ratio) =>
      h("circle", {
        class: "context-ring-arc",
        cx: 9,
        cy: 9,
        r: RADIUS,
        "stroke-dasharray": `${(CIRCUMFERENCE * ratio).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`,
        transform: "rotate(-90 9 9)",
      });
    return () => {
      const value = view.value;
      return [
        h(
          "button",
          {
            id: "context-ring",
            type: "button",
            class: "composer-setting context-ring",
            "data-level": value.level,
            "aria-haspopup": "dialog",
            "aria-expanded": String(open.value),
            "aria-label": value.label,
            onClick: toggle,
          },
          h(
            "svg",
            {
              viewBox: "0 0 18 18",
              width: 16,
              height: 16,
              focusable: "false",
              "aria-hidden": "true",
            },
            [
              h("circle", {
                class: "context-ring-track",
                cx: 9,
                cy: 9,
                r: RADIUS,
              }),
              value.ratio > 0 ? arc(value.ratio) : null,
            ],
          ),
        ),
        open.value &&
          h(
            "div",
            {
              id: "context-popover",
              role: "dialog",
              "aria-label": "上下文用量",
            },
            [
              h("div", { class: "status-popover-title" }, [
                h("strong", [icon("tokens"), "上下文"]),
              ]),
              h("div", { class: "status-popover-body context-popover-body" }, [
                h(DetailRows, { session, kind: "context", now: Date.now() }),
                h("div", { class: "context-popover-actions" }, [
                  conversation.compacting
                    ? h("span", { class: "context-compacting" }, "正在压缩上下文…")
                    : null,
                  h(
                    "button",
                    {
                      id: "context-compact",
                      type: "button",
                      class: "primary",
                      // 压缩发生在一次 agent run 内部：正在生成本轮或已经在压缩时不能再排一次。
                      disabled:
                        conversation.compacting ||
                        session.busy ||
                        session.connection !== "connected",
                      title: session.busy
                        ? "本轮正在生成，结束后才能压缩"
                        : "压缩当前上下文（/compact）",
                      onClick: compact,
                    },
                    "压缩上下文",
                  ),
                ]),
              ]),
            ],
          ),
      ];
    };
  },
});
