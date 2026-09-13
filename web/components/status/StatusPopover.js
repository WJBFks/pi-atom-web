import { defineComponent, h } from "vue";
import { icon } from "../../icons.js";
import DetailRows from "./DetailRows.js";

export default defineComponent({
  name: "StatusPopover",
  props: {
    session: Object,
    kind: { type: String, default: "session" },
    now: Number,
    sidebar: Boolean,
  },
  setup(props) {
    const titles = {
      session: "会话信息",
      conversation: "对话与轨迹",
      tokens: "Token 用量",
      cache: "缓存与成本",
    };
    return () =>
      h(
        "div",
        { id: props.sidebar ? "session-info-popover" : "status-popover" },
        [
          !props.sidebar &&
            h("div", { class: "status-popover-title" }, [
              h("strong", [icon(props.kind), titles[props.kind]]),
            ]),
          h(
            "div",
            {
              class: props.sidebar
                ? "session-info-body"
                : "status-popover-body",
            },
            [
              h(DetailRows, {
                session: props.session,
                kind: props.kind,
                now: props.now,
              }),
            ],
          ),
        ],
      );
  },
});
