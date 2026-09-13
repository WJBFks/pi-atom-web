import {
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  shallowRef,
  watch,
} from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import { useSettingsStore } from "../../stores/settings.js";
import HistoryFeed from "./HistoryFeed.js";
import LiveFeed from "./LiveFeed.js";

export default defineComponent({
  name: "ConversationFeed",
  props: { trace: Boolean },
  emits: ["atBottomChange"],
  setup(props, { emit, expose }) {
    const conversation = useConversationStore();
    const settings = useSettingsStore();
    const scroll = shallowRef();
    const follow = shallowRef(true);
    let bottomFrame;
    const bottom = () => {
      const node = scroll.value;
      if (node && follow.value)
        node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    };
    const track = () => {
      const node = scroll.value;
      const next = Boolean(
        node && node.scrollHeight - node.scrollTop - node.clientHeight <= 1,
      );
      if (next === follow.value) return;
      follow.value = next;
      emit("atBottomChange", next);
    };
    const scrollToBottom = () => {
      if (!follow.value) {
        follow.value = true;
        emit("atBottomChange", true);
      }
      bottom();
      nextTick(() => {
        bottom();
        cancelAnimationFrame(bottomFrame);
        bottomFrame = requestAnimationFrame(bottom);
      });
    };
    expose({ scrollToBottom });
    onMounted(() => {
      scrollToBottom();
      nextTick(track);
    });
    onUnmounted(() => cancelAnimationFrame(bottomFrame));
    watch(
      () => [conversation.revision, props.trace],
      () => {
        // 关闭「自动跟随最新消息」后，只有手动点回底部才会再跟随。
        if (follow.value && settings.autoFollow) nextTick(bottom);
      },
      { flush: "post" },
    );
    return () =>
      h("div", { id: "scroll", ref: scroll, onScroll: track }, [
        h("div", { id: "messages" }, [
          h(HistoryFeed, { trace: props.trace }),
          h(LiveFeed, { trace: props.trace }),
          !conversation.messages.length &&
            !conversation.pendingUserMessages.length &&
            conversation.responseWaitStartedAt == null &&
            !conversation.liveMessage &&
            !conversation.tools.length &&
            h("div", { id: "message-empty", class: "empty" }, [
              h("div", { class: "symbol" }, "π"),
              h("h1", "同一个 pi，新的视角。"),
              h("p", "从这里继续，你的终端会同步这段对话。"),
            ]),
        ]),
      ]);
  },
});
