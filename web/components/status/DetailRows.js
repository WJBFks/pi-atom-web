import { defineComponent, h, ref } from "vue";
import { icon } from "../../icons.js";
import { writeClipboard } from "../../clipboard.js";
import { statusRows } from "./format.js";

// 状态明细行（标签 / 值 / 复制按钮）：状态栏弹层、设置页与会话信息共用同一份渲染，
// 避免同一种行在两处出现不同样式。
export default defineComponent({
  name: "DetailRows",
  props: {
    session: Object,
    kind: { type: String, default: "session" },
    now: Number,
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
    return () => [
      ...statusRows(props.kind, props.session, props.now).map((row) =>
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
      error.value
        ? h("p", { role: "alert", class: "failure" }, error.value)
        : null,
    ];
  },
});
