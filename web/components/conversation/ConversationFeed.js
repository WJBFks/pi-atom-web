import {
  defineComponent,
  h,
  nextTick,
  onMounted,
  shallowRef,
  watch,
} from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import HistoryFeed from "./HistoryFeed.js";
import LiveFeed from "./LiveFeed.js";

export default defineComponent({
  name: "ConversationFeed",
  props: { trace: Boolean },
  setup(props) {
    const conversation = useConversationStore();
    const scroll = shallowRef();
    const follow = shallowRef(true);
    const bottom = () => {
      const node = scroll.value;
      if (node && follow.value)
        node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    };
    const track = () => {
      const node = scroll.value;
      follow.value = Boolean(
        node && node.scrollHeight - node.scrollTop - node.clientHeight < 100,
      );
    };
    onMounted(bottom);
    watch(
      () => [conversation.revision, props.trace],
      () => {
        if (follow.value) nextTick(bottom);
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
