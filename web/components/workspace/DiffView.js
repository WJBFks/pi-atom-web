import { defineComponent, h, ref, computed } from "vue";

export function parseDiffRows(patch) {
  const rows = [], lines = String(patch || "").split("\n");
  let oldLine = 1, newLine = 1, added = 0, removed = 0, inHunk = false;
  const metadata = [];
  for (let i = 0; i < lines.length;) {
    const hunk = /^@@ -(\d+)/.exec(lines[i]);
    if (hunk) { inHunk = true; metadata.push(lines[i]); oldLine = Number(hunk[1]); const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines[i]); if (match) newLine = Number(match[1]); i++; continue; }
    const line = lines[i];
    if (line.startsWith("diff ")) inHunk = false;
    if (!inHunk) { if (line) metadata.push(line); i++; continue; }
    if (line.startsWith("-")) {
      const removedLines = [], addedLines = [];
      while (i < lines.length && lines[i].startsWith("-")) removedLines.push(lines[i++].slice(1));
      while (i < lines.length && lines[i].startsWith("+")) addedLines.push(lines[i++].slice(1));
      const count = Math.max(removedLines.length, addedLines.length);
      for (let n = 0; n < count; n++) rows.push({ left: removedLines[n] ?? "", right: addedLines[n] ?? "", lineNo: { left: n < removedLines.length ? oldLine++ : "", right: n < addedLines.length ? newLine++ : "" }, type: n < removedLines.length && n < addedLines.length ? "change" : n < removedLines.length ? "delete" : "add" });
      removed += removedLines.length; added += addedLines.length; continue;
    }
    if (line.startsWith("+")) { rows.push({ left: "", right: line.slice(1), lineNo: { left: "", right: newLine++ }, type: "add" }); added++; i++; continue; }
    if (line.startsWith(" ")) { const value = line.slice(1); rows.push({ left: value, right: value, lineNo: { left: oldLine++, right: newLine++ }, type: "context" }); i++; continue; }
    if (line) metadata.push(line);
    i++;
  }
  return { rows, added, removed, metadata };
}

export default defineComponent({
  name: "WorkspaceDiffView",
  props: { patch: String },
  setup(props) {
    const mode = ref("split");
    const parsed = computed(() => parseDiffRows(props.patch));
    return () => h("section", { class: "ws-diff-view" }, [
      h("header", { class: "ws-diff-head" }, [h("strong", null, `+${parsed.value.added} −${parsed.value.removed}`), h("button", { onClick: () => mode.value = "split" }, "左右"), h("button", { onClick: () => mode.value = "unified" }, "统一")]),
      h("pre", { class: "ws-diff-metadata" }, parsed.value.metadata.join("\n")),
      mode.value === "split" ? h("div", { class: "ws-diff-grid" }, parsed.value.rows.map((row) => h("div", { class: ["ws-diff-row", row.type] }, [h("span", { class: "line-no" }, row.lineNo.left), h("code", null, row.left), h("span", { class: "line-no" }, row.lineNo.right), h("code", null, row.right)]))) : h("div", { class: "ws-diff-unified" }, parsed.value.rows.flatMap(row => {
        const item = (type, number, value) => h("div", { class: ["ws-diff-row", type] }, [h("span", { class: "line-no" }, number), h("code", null, value)]);
        return row.type === "change" ? [item("delete", row.lineNo.left, `- ${row.left}`), item("add", row.lineNo.right, `+ ${row.right}`)] : [item(row.type, row.lineNo.left || row.lineNo.right, row.type === "delete" ? `- ${row.left}` : row.type === "add" ? `+ ${row.right}` : `  ${row.left}`)];
      })),
    ]);
  },
});
