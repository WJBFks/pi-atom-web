import {
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  shallowRef,
  watch,
} from "vue";

export default defineComponent({
  name: "ResponseWaiting",
  props: { startedAt: { type: Number, required: true } },
  setup(props) {
    const now = shallowRef(Date.now());
    let timer;
    const start = () => {
      clearInterval(timer);
      now.value = Date.now();
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    };
    onMounted(start);
    watch(() => props.startedAt, start);
    onUnmounted(() => clearInterval(timer));
    return () => {
      const elapsed = Math.max(0, now.value - props.startedAt);
      if (elapsed < 1000) return null;
      return h(
        "div",
        { class: "response-waiting", role: "status" },
        `正在等待模型响应... (${Math.max(1, Math.floor(elapsed / 1000))}s)`,
      );
    };
  },
});
