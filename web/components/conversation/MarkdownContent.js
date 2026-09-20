import { computed, defineComponent, h, onUnmounted } from "vue";
import { renderMarkdown } from "../../markdown.js";
import { writeClipboard } from "../../clipboard.js";

export default defineComponent({
  name: "MarkdownContent",
  props: {
    text: { type: String, default: "" },
    live: Boolean,
    // 保留单个换行为硬换行（GFM）：问卷 preview 等「多行文本必须按行渲染」的场景
    breaks: Boolean,
  },
  setup(props) {
    const html = computed(() =>
      renderMarkdown(props.text, { live: props.live, breaks: props.breaks }),
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
      h("div", { class: "markdown", innerHTML: html.value, onClick: copy });
  },
});
