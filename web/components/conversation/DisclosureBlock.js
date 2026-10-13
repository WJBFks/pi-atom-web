import { computed, defineComponent, h, ref, useAttrs } from "vue";
import { icon } from "../../icons.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useCascade } from "./cascade.js";

export default defineComponent({
  name: "DisclosureBlock",
  inheritAttrs: false,
  props: {
    blockKey: String,
    open: { type: Boolean, default: undefined },
    defaultOpen: Boolean,
    remember: { type: Boolean, default: true },
    summaryProps: Object,
    rootRef: Function,
    // 标题左侧的类型图标：折叠时显示它，悬停时换成折叠三角 ▸，展开时常态是 ▾
    icon: String,
  },
  emits: ["toggle"],
  setup(props, { emit, slots }) {
    const attrs = useAttrs();
    const conversation = useConversationStore();
    // 开合状态必须**每次从 store 计**，不能是 setup 时的一次性快照：级联折叠写的是
    // 父级的水位线，子级只有重新算才收得起来（见 cascade.js）。
    const ancestors = useCascade();
    const localOpen = ref(props.defaultOpen);
    const expanded = computed(() => {
      if (props.open !== undefined) return props.open;
      if (props.blockKey)
        return conversation.disclosure(
          props.blockKey,
          props.defaultOpen,
          ancestors,
        );
      return localOpen.value;
    });
    return () => {
      const open = expanded.value;
      return h(
        "details",
        {
          ...attrs,
          ref: props.rootRef,
          class: ["disclosure-block", attrs.class],
          "data-key": attrs["data-key"] ?? props.blockKey,
          open,
          onToggle: (event) => {
            const value = event.currentTarget.open;
            // 与计算值相等 = 程序把 open 同步回来的那一次 toggle，不是用户动作：
            // 不写记录、也不级联，否则父级一次折叠会把整片状态写脏。
            if (value !== open) {
              localOpen.value = value;
              if (props.remember && props.blockKey) {
                conversation.setDisclosure(props.blockKey, value);
                // 级联：手动折叠父级时，其下所有折叠块一并收起。
                if (!value) conversation.markCollapsed(props.blockKey);
              }
            }
            emit("toggle", event);
          },
        },
        [
          h("summary", props.summaryProps, [
            props.icon
              ? h("span", { class: "disclosure-icon" }, [
                  h("span", { class: "disclosure-type-icon" }, [
                    icon(props.icon),
                  ]),
                  h("span", { class: "disclosure-caret" }),
                ])
              : null,
            slots.summary?.(),
          ]),
          h("div", { class: "disclosure-body" }, slots.default?.()),
        ],
      );
    };
  },
});
