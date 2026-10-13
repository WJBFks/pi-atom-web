import { defineComponent, h } from "vue";

function blocksOf(text) {
  const lines = String(text || "").split("\n"), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<<")) continue;
    const mid = lines.findIndex((line, n) => n > i && line.startsWith("======="));
    const end = lines.findIndex((line, n) => n > mid && line.startsWith(">>>>>>>"));
    if (mid < 0 || end < 0) continue;
    const ancestor = lines.findIndex((line, n) => n > i && n < mid && line.startsWith("|||||||"));
    blocks.push({ start: i, end, ours: lines.slice(i + 1, ancestor < 0 ? mid : ancestor).join("\n"), theirs: lines.slice(mid + 1, end).join("\n") });
    i = end;
  }
  return blocks;
}

export default defineComponent({
  name: "WorkspaceConflictEditor",
  props: { conflict: Object },
  emits: ["update-result", "save", "cancel"],
  setup(props, { emit }) {
    const choose = (block, value) => {
      const lines = String(props.conflict.result || "").split("\n");
      lines.splice(block.start, block.end - block.start + 1, ...value.split("\n"));
      emit("update-result", lines.join("\n"));
    };
    return () => {
      const blocks = blocksOf(props.conflict?.result);
      return h("section", { class: "ws-conflict-editor" }, [
        props.conflict?.binary ? h("p", { class: "ws-warning" }, "二进制冲突不能在文本编辑器中合并。") : null,
        h("div", { class: "ws-conflict" }, [h("label", null, ["本地版本", h("textarea", { value: props.conflict?.ours, readonly: true })]), h("label", null, ["对方版本", h("textarea", { value: props.conflict?.theirs, readonly: true })]), h("label", null, ["合并结果", h("textarea", { value: props.conflict?.result, onInput: (event) => emit("update-result", event.target.value) })])]),
        ...blocks.map((block, index) => h("div", { class: "ws-conflict-block" }, [`冲突块 ${index + 1}`, h("pre", null, block.ours), h("pre", null, block.theirs), h("button", { onClick: () => choose(block, block.ours) }, "采用本地块"), h("button", { onClick: () => choose(block, block.theirs) }, "采用对方块"), h("button", { onClick: () => choose(block, [block.ours, block.theirs].filter(Boolean).join("\n")) }, "采用双方")])),
        h("button", { onClick: () => emit("save", "ours") }, "保留本地版本"), h("button", { onClick: () => emit("save", "theirs") }, "保留对方版本"),
        h("button", { disabled: props.conflict?.binary || blocks.length > 0, onClick: () => emit("save") }, "保存合并结果并暂存"), h("button", { onClick: () => emit("cancel") }, "返回"),
      ]);
    };
  },
});
