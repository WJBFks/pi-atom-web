import { computed, defineComponent, h, onUnmounted } from "vue";
import { renderMarkdown } from "../../markdown.js";
import { writeClipboard } from "../../clipboard.js";

export default defineComponent({
  name: "MarkdownContent",
  props: { text: { type: String, default: "" }, live: Boolean },
  setup(props) {
    const html = computed(() =>
      renderMarkdown(props.text, { live: props.live }),
    );
    let resetTimer,
      disposed = false;
    const copy = async (event) => {
      const button = event.target.closest?.(".code-copy");
      if (!button) return;
      const source =
        button.closest(".code-block")?.querySelector(".code-source code")
          ?.textContent || "";
      clearTimeout(resetTimer);
      try {
        await writeClipboard(source);
        if (disposed || !button.isConnected) return;
        button.textContent = "已复制";
      } catch {
        if (disposed || !button.isConnected) return;
        button.textContent = "复制失败";
      }
      resetTimer = setTimeout(() => {
        if (button.isConnected) button.textContent = "复制";
      }, 1500);
    };
    onUnmounted(() => {
      disposed = true;
      clearTimeout(resetTimer);
    });
    return () =>
      h("div", { class: "body", innerHTML: html.value, onClick: copy });
  },
});
