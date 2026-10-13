import { defineComponent, h, computed, nextTick, ref, watch } from "vue";
import { icon } from "../../icons.js";
import { writeClipboard } from "../../clipboard.js";
import { codeBlock } from "../../markdown.js";
import { refreshLineWrap, wrapLines } from "../../line-wrap.js";

export default defineComponent({
  name: "WorkspaceFileEditor",
  props: { quickPreview: Boolean, file: Object, text: String, editing: Boolean, dirty: Boolean, eof: Boolean, startLine: { type: Number, default: 1 } },
  emits: ["open-tab", "edit", "toggle-edit", "save", "reload", "force", "rename", "delete", "download", "next-page"],
  setup(props, { emit }) {
    const menuOpen = ref(false);
    watch(() => props.file?.path, () => menuOpen.value = false);
    const editor = ref(null), gutter = ref(null), preview = ref(null);
    const wrap = wrapLines;
    const source = computed(() => props.text ?? props.file?.text ?? "");
    const rendered = computed(() => codeBlock(source.value, props.file?.path.split(".").pop(), { startLine: props.startLine, highlight: source.value.length < 100000 }));
    // 行号逐行对齐由 `web/line-wrap.js` 统一做（正文与行号列都在它的宿主选择器里）：
    // 这里只负责在换行开关、正文、模式、分页起点变了以后催一次。
    watch(() => [wrap.value, source.value, props.editing, props.startLine, props.file?.path], () => nextTick(refreshLineWrap));
    watch(() => [props.file?.path, props.file?.focusLine, props.editing], async () => {
      await nextTick();
      const row = Math.max(0, (props.file?.focusLine || 1) - props.startLine);
      // 跳转偏移：换行态下不能再用「行号 × 行高」（会跳错行），改成把行号列前 row 格的高度加起来。
      const offset = (cells, fallback) => cells?.children.length > row
        ? Array.from(cells.children).slice(0, row).reduce((sum, cell) => sum + cell.getBoundingClientRect().height, 0)
        : row * (parseFloat(getComputedStyle(fallback).lineHeight) || 18);
      if (props.editing && editor.value) {
        const element = editor.value, position = source.value.split("\n").slice(0, row).reduce((sum, line) => sum + line.length + 1, 0);
        element.setSelectionRange(position, position); element.scrollTop = offset(gutter.value, element);
        if (gutter.value) gutter.value.scrollTop = element.scrollTop;
      } else if (preview.value) { const scroll = preview.value.querySelector(".code-scroll"), code = preview.value.querySelector(".code-source"); if (scroll && code) scroll.scrollTop = offset(preview.value.querySelector(".code-lines"), code); }
    }, { immediate: true });

    return () => {
      const file = props.file;
      if (!file) return h("div", { class: "ws-empty" }, "选择文件查看内容");
      const content = props.text ?? file.text ?? "";
      const body = file.image && file.data
        ? h("img", { class: "ws-image", src: file.data.startsWith("data:") ? file.data : `data:${file.mime || "image/*"};base64,${file.data}`, alt: file.path })
        : file.binary ? h("div", { class: "ws-empty" }, "二进制文件，请下载查看")
          : props.editing
            // 行号列交给 line-wrap.js 填（换行态是一格一行 + 逐格高度，关闭态是整块文本），
            // 所以这里必须留空；起始行号通过 data-start-line 传过去（分页预览从第 N 行开始）。
            ? h("div", { class: "ws-code", "data-start-line": props.startLine }, [
              h("div", { ref: gutter, class: "ws-lines" }),
              h("textarea", { ref: editor, value: content, spellcheck: false, readonly: !file.editable, onScroll: event => { if (gutter.value) gutter.value.scrollTop = event.target.scrollTop; }, onInput: (event) => emit("edit", event.target.value), "aria-label": `编辑 ${file.path}` })])
            : h("div", { ref: preview, class: "ws-rendered-code", innerHTML: rendered.value });
      const text = !file.image && !file.binary;
      return h("div", { class: "ws-editor-content" }, [
        h("div", { class: "ws-editor-head" }, [h("span", null, file.path), props.quickPreview && h("button", { class: "ws-editor-icon", title: "在标签中打开", "aria-label": "在标签中打开", onClick: () => emit("open-tab") }, icon("open-tab")),
          text && h("button", { class: ["ws-editor-icon", wrap.value && "active"], title: wrap.value ? "关闭自动换行" : "自动换行", "aria-label": "自动换行", "aria-pressed": wrap.value, onClick: () => wrap.value = !wrap.value }, icon("wrap")),
          h("div", { class: "ws-editor-menu", onFocusout: event => { if (!event.currentTarget.contains(event.relatedTarget)) menuOpen.value = false; }, onKeydown: event => { if (event.key === "Escape") menuOpen.value = false; } }, [h("button", { class: "ws-editor-icon", title: "更多操作", "aria-label": "更多操作", "aria-expanded": menuOpen.value, onClick: () => menuOpen.value = !menuOpen.value }, icon("more")), menuOpen.value && h("div", { class: "ws-editor-menu-items" }, [h("button", { onClick: () => writeClipboard(file.path).catch(() => {}) }, "复制路径"), file.editable && !file.binary && !file.image && h("button", { onClick: () => (menuOpen.value = false, emit("toggle-edit")) }, props.editing ? "预览" : "编辑"), h("button", { onClick: () => (menuOpen.value = false, emit("save")), disabled: !props.dirty || !file.editable }, "保存"), props.dirty && h("button", { onClick: () => (menuOpen.value = false, emit("reload")) }, "重载"),  h("button", { onClick: () => (menuOpen.value = false, emit("rename")) }, "重命名"), h("button", { onClick: () => (menuOpen.value = false, emit("delete")) }, "删除"), h("button", { onClick: () => (menuOpen.value = false, emit("download")) }, "下载"), !props.eof && h("button", { onClick: () => (menuOpen.value = false, emit("next-page")) }, "下一页")])]), props.dirty && h("b", { class: "ws-warning" }, "未保存")]),
        body,
        file.reason ? h("p", { class: "ws-status" }, file.reason) : !props.eof && !file.editable ? h("p", { class: "ws-status" }, "继续加载其余分页后才能编辑。") : null,
      ]);
    };
  },
});
