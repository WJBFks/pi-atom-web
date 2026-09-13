import { defineComponent, h } from "vue";
import DisclosureBlock from "./DisclosureBlock.js";

// 一轮的中间过程折叠块：标题是「x 次思考过程 · y 次工具调用 · …」，
// 正文由调用方塞入（复用现有的消息/工具卡渲染）。复用 DisclosureBlock 的
// details/summary 结构，但去掉卡片外框，只保留一行 muted 标题 + 原生三角。
export default defineComponent({
  name: "TurnGroup",
  props: {
    title: String,
    blockKey: String,
    open: { type: Boolean, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        DisclosureBlock,
        {
          class: "turn-group",
          blockKey: props.blockKey,
          open: props.open,
        },
        {
          summary: () => h("span", { class: "turn-title" }, props.title),
          default: () => slots.default?.(),
        },
      );
  },
});
