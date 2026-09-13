import { defineComponent, h } from "vue";
import { icon } from "../../icons.js";
const labels = {
  off: "关闭",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
export default defineComponent({
  name: "ThinkingPicker",
  props: {
    levels: { type: Array, default: () => ["off"] },
    selected: String,
    busy: Boolean,
    chooseLevel: Function,
  },
  setup(props) {
    return () =>
      h(
        "div",
        {
          id: "thinking-picker",
          class: "setting-picker thinking-picker",
          role: "dialog",
          "aria-label": "选择思考等级",
        },
        [
          h("strong", "思考级别"),
          ...props.levels.map((level) =>
            h(
              "button",
              {
                key: level,
                type: "button",
                "data-thinking-level": level,
                class: { selected: level === props.selected },
                disabled: props.busy,
                onClick: () => props.chooseLevel?.(level),
              },
              [
                level === props.selected && icon("check"),
                labels[level] || level,
              ],
            ),
          ),
        ],
      );
  },
});
