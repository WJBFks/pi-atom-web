import { computed, defineComponent, h } from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import { useSettingsStore } from "../../stores/settings.js";
import DisclosureBlock from "./DisclosureBlock.js";
import { provideCascade } from "./cascade.js";

// 一轮的中间过程折叠块：标题是「思考`3` · 工具调用`5` · …」（数量是行内代码样式的徽片），
// 正文由调用方塞入（复用现有的消息/工具卡渲染）。复用 DisclosureBlock 的
// details/summary 结构，但去掉卡片外框，只保留一行 muted 标题 + 原生三角。
//
// 展开状态（用户 2026-09-24 改口径）：**进行过程中保持展开，本轮一结束就立即自动折叠**
//（不再是“等到下一个用户输入开始”）；只要用户手动点过轮次标题就不再自动折叠。
// 因此必须 remember:false + 用户意图守卫，否则浏览器在程序改动 open 时也会派发 toggle，
// 把瞬态状态误记成用户选择。“手动过”只算轮次标题自己被点，在其里面上开合某个组不算。
export default defineComponent({
  name: "TurnGroup",
  props: {
    title: String,
    titleParts: Array,
    blockKey: String,
    keepOpen: Boolean,
  },
  setup(props, { slots }) {
    const conversation = useConversationStore();
    const settings = useSettingsStore();
    // 级联：手动收起本轮时，组内的中间过程组与卡片一并收起。
    provideCascade(props.blockKey);
    let intentAt = 0;
    // 关闭「自动折叠中间过程」后始终展开（用户手动折叠仍然优先）。
    const open = computed(() =>
      conversation.disclosure(
        props.blockKey,
        !settings.autoCollapse || props.keepOpen,
      ),
    );
    const markIntent = (event) => {
      if (event.type === "keydown" && !["Enter", " "].includes(event.key))
        return;
      intentAt = Date.now();
    };
    const toggled = (event) => {
      if (Date.now() - intentAt < 1_000) {
        intentAt = 0;
        const open = event.currentTarget.open;
        conversation.setDisclosure(props.blockKey, open);
        // 只有用户真的把它收起来才记水位线（级联不能由程序触发）。
        if (!open) conversation.markCollapsed(props.blockKey);
      }
    };
    return () =>
      h(
        DisclosureBlock,
        {
          class: "turn-group",
          blockKey: props.blockKey,
          open: open.value,
          remember: false,
          onToggle: toggled,
          summaryProps: { onPointerdown: markIntent, onKeydown: markIntent },
        },
        {
          summary: () => {
            const parts = props.titleParts || [];
            if (!parts.length)
              return h("span", { class: "turn-title" }, props.title || "");
            const counts = [];
            parts.forEach((part, index) => {
              if (index)
                counts.push(
                  h("span", { class: "turn-title-separator", key: `s${index}` }, "·"),
                );
              counts.push(
                h(
                  "span",
                  { class: "turn-count", key: `${part.label}${index}` },
                  [part.label, h("code", String(part.value))],
                ),
              );
            });
            return h("span", { class: "turn-title" }, counts);
          },
          default: () => slots.default?.(),
        },
      );
  },
});
