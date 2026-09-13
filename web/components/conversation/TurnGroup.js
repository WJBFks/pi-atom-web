import { computed, defineComponent, h } from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import DisclosureBlock from "./DisclosureBlock.js";

// 一轮的中间过程折叠块：标题是「x 次思考过程 · y 次工具调用 · …」，
// 正文由调用方塞入（复用现有的消息/工具卡渲染）。复用 DisclosureBlock 的
// details/summary 结构，但去掉卡片外框，只保留一行 muted 标题 + 原生三角。
//
// 展开状态：执行中默认展开、整轮结束后自动收起；只有用户手动操作过才写入
// disclosures（因此必须 remember:false + 用户意图守卫，否则浏览器在程序改动
// open 时也会派发 toggle，把瞬态状态误记成用户选择）。
export default defineComponent({
  name: "TurnGroup",
  props: {
    title: String,
    blockKey: String,
    running: Boolean,
  },
  setup(props, { slots }) {
    const conversation = useConversationStore();
    let intentAt = 0;
    const open = computed(() =>
      conversation.disclosure(props.blockKey, props.running),
    );
    const markIntent = (event) => {
      if (event.type === "keydown" && !["Enter", " "].includes(event.key))
        return;
      intentAt = Date.now();
    };
    const toggled = (event) => {
      if (Date.now() - intentAt < 1_000) {
        intentAt = 0;
        conversation.setDisclosure(props.blockKey, event.currentTarget.open);
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
          summary: () => h("span", { class: "turn-title" }, props.title),
          default: () => slots.default?.(),
        },
      );
  },
});
