import { computed, defineComponent, h } from "vue";
import { codeBlock } from "../../markdown.js";
import { writeClipboard } from "../../clipboard.js";
import DisclosureBlock from "./DisclosureBlock.js";

export default defineComponent({
  name: "CustomEntryBlock",
  props: { message: { type: Object, required: true } },
  setup(props) {
    const structured = computed(
      () => props.message.data !== null && typeof props.message.data === "object",
    );
    const json = computed(() => JSON.stringify(props.message.data, null, 2));
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const preview = computed(() =>
      props.message.collapsedText
        ? compact(props.message.collapsedText)
        : structured.value
          ? "[JSON OBJECT]"
          : compact(props.message.data),
    );
    const copy = async (event) => {
      const button = event.target.closest?.(".code-copy");
      if (!button) return;
      event.stopPropagation();
      const source = button.closest(".code-block")?.querySelector(".code-source code")?.textContent || "";
      try {
        await writeClipboard(source);
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }
    };
    return () =>
      h(
        DisclosureBlock,
        {
          class: "custom-entry-block",
          blockKey: props.message.id,
          "data-custom-entry": props.message.customType,
        },
        {
          summary: () => [
            h("span", { class: "disclosure-summary-row" }, [
              h("strong", props.message.customType),
              h("span", { class: "disclosure-meta" }, "自定义 Entry"),
              h("span", { class: "disclosure-preview custom-entry-preview" }, preview.value),
            ]),
          ],
          default: () => [
            props.message.expandedText
              ? h("pre", { class: "custom-entry-rendered" }, props.message.expandedText)
              : structured.value
                ? h("div", {
                    class: "custom-entry-data",
                    innerHTML: codeBlock(json.value, "json"),
                    onClick: copy,
                  })
                : h("div", { class: "custom-entry-rendered" }, String(props.message.data ?? "")),
            props.message.expandedText &&
              h("details", { class: "custom-entry-raw" }, [
                h("summary", "原始数据"),
                h("div", {
                  class: "custom-entry-data",
                  innerHTML: codeBlock(json.value, "json"),
                  onClick: copy,
                }),
              ]),
          ],
        },
      );
  },
});
