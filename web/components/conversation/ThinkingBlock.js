import {
  computed,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import {
  useConversationClock,
  useConversationStore,
} from "../../stores/conversation.js";
import { formatDuration } from "./ToolCallBlock.js";
import MarkdownContent from "./MarkdownContent.js";
import DisclosureBlock from "./DisclosureBlock.js";

export default defineComponent({
  name: "ThinkingBlock",
  props: {
    text: { type: String, default: "" },
    blockKey: { type: String, required: true },
    running: Boolean,
  },
  setup(props) {
    const conversation = useConversationStore();
    const clock = useConversationClock();
    const element = ref(),
      preview = ref();
    const compact = computed(() => props.text.replace(/\s+/g, " ").trim());
    const open = computed(() =>
      conversation.thinkingTouched.has(props.blockKey)
        ? Boolean(conversation.thinkingOpen.get(props.blockKey))
        : conversation.disclosure(props.blockKey, props.running),
    );
    const timing = computed(() => conversation.thinkingTiming(props.blockKey));
    const dynamic = computed(
      () => timing.value?.durationMs == null && timing.value?.startedAt != null,
    );
    const elapsed = computed(
      () =>
        timing.value?.durationMs ??
        (timing.value?.startedAt == null
          ? null
          : clock.now.value - timing.value.startedAt),
    );
    let clockActive = false,
      resizeObserver,
      fitFrame,
      userIntentAt = 0,
      disposed = false;

    watch(
      dynamic,
      (active) => {
        if (active === clockActive) return;
        clockActive = active;
        active ? clock.start() : clock.stop();
      },
      { immediate: true },
    );
    watch([compact, open], () => nextTick(scheduleFit), { flush: "post" });

    const fit = () => {
      fitFrame = undefined;
      const node = preview.value;
      if (!node || element.value?.open) return;
      const full = compact.value;
      node.textContent = full;
      if (node.scrollWidth <= node.clientWidth) return;
      let low = 0,
        high = full.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        node.textContent = `${full.slice(0, middle).trimEnd()}...`;
        if (node.scrollWidth <= node.clientWidth) low = middle;
        else high = middle - 1;
      }
      node.textContent = `${full.slice(0, low).trimEnd()}...`;
    };
    const scheduleFit = () => {
      if (disposed) return;
      if (fitFrame != null) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(fit);
    };
    const markIntent = (event) => {
      if (event.type === "keydown" && !["Enter", " "].includes(event.key))
        return;
      userIntentAt = Date.now();
    };
    const toggled = (event) => {
      if (Date.now() - userIntentAt < 1_000) {
        conversation.setThinking(props.blockKey, event.currentTarget.open);
        userIntentAt = 0;
      }
      if (!event.currentTarget.open) nextTick(scheduleFit);
    };

    onMounted(() => {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(element.value);
      scheduleFit();
    });
    onUnmounted(() => {
      disposed = true;
      if (clockActive) clock.stop();
      resizeObserver?.disconnect();
      if (fitFrame != null) cancelAnimationFrame(fitFrame);
    });

    return () =>
      h(
        DisclosureBlock,
        {
          rootRef: (node) => {
            element.value = node;
          },
          class: "thinking-block",
          blockKey: props.blockKey,
          open: open.value,
          remember: false,
          icon: "thinking",
          onToggle: toggled,
          summaryProps: { onPointerdown: markIntent, onKeydown: markIntent },
        },
        {
          summary: () => [
            h("span", { class: "thinking-row" }, [
              h("strong", "思考"),
              h("span", { class: "disclosure-separator" }, "·"),
              h(
                "span",
                {
                  ref: preview,
                  class: "thinking-preview",
                  "data-full": compact.value,
                },
                compact.value,
              ),
            ]),
            h(
              "span",
              { class: "thinking-duration" },
              elapsed.value == null
                ? "--"
                : [
                    h(
                      "span",
                      { class: "duration-collapsed" },
                      formatDuration(elapsed.value, false),
                    ),
                    h(
                      "span",
                      { class: "duration-expanded" },
                      formatDuration(elapsed.value, true),
                    ),
                  ],
            ),
          ],
          default: () => [h("div", { class: "thinking-body" }, [
            h(MarkdownContent, { text: props.text, live: props.running }),
          ])],
        },
      );
  },
});
