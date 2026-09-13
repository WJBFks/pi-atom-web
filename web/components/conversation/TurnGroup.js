import { computed, defineComponent, h } from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import { useSettingsStore } from "../../stores/settings.js";
import DisclosureBlock from "./DisclosureBlock.js";

// 一轮的中间过程折叠块：标题是「x 次思考过程 · y 次工具调用 · …」，
// 正文由调用方塞入（复用现有的消息/工具卡渲染）。复用 DisclosureBlock 的
// details/summary 结构，但去掉卡片外框，只保留一行 muted 标题 + 原生三角。
//
// 展开状态：默认展开，直到下一个用户输入开始才自动收起；只有用户手动操作过就
// 不再自动收起（因此必须 remember:false + 用户意图守卫，否则浏览器在程序改动
// open 时也会派发 toggle，把瞬态状态误记成用户选择）。
export default defineComponent({
  name: "TurnGroup",
  props: {
    title: String,
    blockKey: String,
    keepOpen: Boolean,
  },
  setup(props, { slots }) {
    const conversation = useConversationStore();
    const settings = useSettingsStore();
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
