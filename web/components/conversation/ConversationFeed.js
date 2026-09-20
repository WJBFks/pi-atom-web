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
  props: {
    trace: Boolean,
    token: String,
    onError: Function,
    onLoadOlderHistory: Function,
  },
  emits: ["atBottomChange"],
  setup(props, { emit, expose }) {
    const conversation = useConversationStore();
    const settings = useSettingsStore();
    const scroll = shallowRef();
    const follow = shallowRef(true);
    let bottomFrame;
    let historyTopArmed = true;
    let prependHeight = 0;
    let prependTop = 0;
    const HISTORY_TOP_THRESHOLD = 48;
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
    const trackHistory = () => {
      const node = scroll.value;
      if (!node) return;
      if (node.scrollTop > HISTORY_TOP_THRESHOLD) {
        historyTopArmed = true;
        return;
      }
      if (!historyTopArmed || conversation.historyComplete) return;
      historyTopArmed = false;
      props.onLoadOlderHistory?.();
    };
    const onScroll = () => {
      track();
      trackHistory();
    };
    const onWheel = (event) => {
      if (event.deltaY < 0) trackHistory();
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
    watch(
      () => conversation.prependedCount,
      () => {
        const node = scroll.value;
        if (!node) return;
        prependHeight = node.scrollHeight;
        prependTop = node.scrollTop;
        nextTick(() => {
          const current = scroll.value;
          if (!current) return;
          current.scrollTop =
            prependTop + Math.max(0, current.scrollHeight - prependHeight);
          track();
        });
      },
      { flush: "pre" },
    );
    return () =>
      h("div", { id: "scroll", ref: scroll, onScroll, onWheel }, [
        h("div", { id: "messages" }, [
          h(HistoryFeed, {
            trace: props.trace,
            token: props.token,
            onError: props.onError,
          }),
          h(LiveFeed, {
            trace: props.trace,
            token: props.token,
            onError: props.onError,
          }),
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
