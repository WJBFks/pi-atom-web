import { defineComponent, h, ref, watch } from "vue";
import { icon } from "../../icons.js";

function statusOf(code = "") {
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) return { color: "conflict", label: "U", description: "合并冲突" };
  if (code.includes("D")) return { color: "deleted", label: "D", description: "删除" };
  if (/[RMCT]/.test(code)) return { color: "modified", label: code.includes("R") ? "R" : "M", description: code.includes("R") ? "重命名" : "修改" };
  if (/[A?]/.test(code)) return { color: "added", label: code.includes("?") ? "?" : "A", description: code.includes("?") ? "未跟踪" : "新增" };
  return null;
}

export default defineComponent({
  name: "WorkspaceFileTree",
  props: { entries: { type: Array, default: () => [] }, rootPath: String, gitStatuses: { type: Object, default: () => ({}) }, activePath: String, expanded: { type: Set, default: () => new Set() }, changedPaths: { type: Array, default: () => [] } },
  emits: ["select", "select-dir", "expand", "rename", "delete", "create-file", "create-directory"],
  setup(props, { emit }) {
    const rootExpanded = ref(true);
    const menuPath = ref(null);
    watch(() => props.rootPath, () => rootExpanded.value = true);
    const rows = (items, depth = 1) => (items || []).map((entry) => {
      let status = statusOf(props.gitStatuses[entry.path]);
      if (!status && entry.directory) { const nested = Object.entries(props.gitStatuses).filter(([path]) => path.startsWith(`${entry.path}/`)).map(([,code]) => statusOf(code)).filter(Boolean); status = nested.find(item => item.color === "conflict" || item.color === "deleted") || nested.find(item => item.color === "modified") || nested[0]; }
      const row = h("div", { style: { "--ws-tree-depth": depth }, class: ["ws-tree-row", props.activePath === entry.path && "active", status && `git-${status.color}`, entry.ignored && "ignored", entry.directory && "directory"] }, [
        h("button", { class: ["ws-entry", props.activePath === entry.path && "active"], onClick: () => entry.directory ? (emit("select-dir", entry), emit("expand", entry)) : emit("select", entry), title: `${entry.path}${status ? ` · ${status.description} (${props.gitStatuses[entry.path] || "子项有变更"})` : ""}` }, [
          h("span", { class: "ws-tree-chevron" }, entry.directory ? icon(props.expanded.has(entry.path) ? "chevron-down" : "chevron-right") : null),
          h("span", { class: "ws-tree-icon" }, icon(entry.directory ? "folder" : "file")),
          h("span", { class: "ws-tree-name" }, entry.name),
          status && h("span", { class: "ws-git-badge", "aria-label": status.description }, entry.directory ? "•" : status.label),
        ]),
        h("div", { class: ["ws-tree-menu", menuPath.value === entry.path && "open"], onFocusout: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) menuPath.value = null; }, onKeydown: (event) => { if (event.key === "Escape") menuPath.value = null; } }, [
          h("button", { class: "ws-tree-action", title: "更多操作", "aria-label": "更多操作", "aria-expanded": menuPath.value === entry.path, onClick: () => menuPath.value = menuPath.value === entry.path ? null : entry.path }, icon("more")),
          menuPath.value === entry.path && h("div", { class: "ws-tree-menu-items" }, [
            h("button", { onClick: () => { menuPath.value = null; emit("rename", entry); } }, "重命名"),
            h("button", { onClick: () => { menuPath.value = null; emit("delete", entry); } }, "删除"),
          ]),
        ]),
      ]);
      return h("div", { class: "ws-tree-node", key: entry.path }, [row, entry.children && props.expanded.has(entry.path) ? h("div", { class: "ws-tree-children" }, rows(entry.children, depth + 1)) : null]);
    });
    return () => h("div", { class: "ws-tree" }, [
      h("div", { class: "ws-root-row" }, [
        h("button", { class: "ws-entry ws-tree-root", title: props.rootPath, "aria-expanded": rootExpanded.value, onClick: () => rootExpanded.value = !rootExpanded.value }, [h("span", { class: "ws-tree-chevron" }, icon(rootExpanded.value ? "chevron-down" : "chevron-right")), h("span", { class: "ws-tree-name" }, `${String(props.rootPath || "").replace(/[\\/]$/, "").split(/[\\/]/).pop() || "工作区"}`)]),
        h("button", { class: "ws-root-action", title: "新建文件", "aria-label": "新建文件", onClick: () => emit("create-file") }, icon("file-plus")),
        h("button", { class: "ws-root-action", title: "新建目录", "aria-label": "新建目录", onClick: () => emit("create-directory") }, icon("folder-plus")),
      ]),
      rootExpanded.value && h("div", { class: "ws-tree-children ws-tree-root-children" }, rows(props.entries)),
    ]);
  },
});
