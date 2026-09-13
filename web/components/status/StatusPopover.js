import { defineComponent, h, ref } from "vue";
import { icon } from "../../icons.js";
import { writeClipboard } from "../../clipboard.js";
import { statusRows } from "./format.js";

export default defineComponent({
  name: "StatusPopover",
  props: {
    session: Object,
    kind: { type: String, default: "session" },
    now: Number,
    sidebar: Boolean,
  },
  setup(props) {
    const copied = ref(""),
      error = ref("");
    const copy = async (row) => {
      try {
        await writeClipboard(row.copy);
        copied.value = row.label;
        error.value = "";
      } catch (cause) {
        error.value = cause.message;
      }
    };
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
            statusRows(props.kind, props.session, props.now).map((row) =>
              h("div", { class: "status-detail", key: row.label }, [
                h("span", row.label),
                h("strong", row.value),
                row.copy !== undefined &&
                  h(
                    "button",
                    {
                      type: "button",
                      "data-copy": row.label,
                      "aria-label": `复制${row.label}`,
                      onClick: () => copy(row),
                    },
                    [icon(copied.value === row.label ? "check" : "copy")],
                  ),
              ]),
            ),
          ),
          error.value &&
            h("p", { role: "alert", class: "failure" }, error.value),
        ],
      );
  },
});
