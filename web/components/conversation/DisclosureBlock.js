import { defineComponent, h, ref, useAttrs } from "vue";
import { icon } from "../../icons.js";
import { useConversationStore } from "../../stores/conversation.js";

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
    const localOpen = ref(
      props.blockKey
        ? conversation.disclosure(props.blockKey, props.defaultOpen)
        : props.defaultOpen,
    );
    return () => {
      const controlled = props.open !== undefined;
      const expanded = controlled ? props.open : localOpen.value;
      return h(
        "details",
        {
          ...attrs,
          ref: props.rootRef,
          class: ["disclosure-block", attrs.class],
          "data-key": attrs["data-key"] ?? props.blockKey,
          open: expanded,
          onToggle: (event) => {
            const value = event.currentTarget.open;
            if (!controlled) localOpen.value = value;
            if (props.remember && props.blockKey)
              conversation.setDisclosure(props.blockKey, value);
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
