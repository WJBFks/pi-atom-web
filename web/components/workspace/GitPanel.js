import { defineComponent, h } from "vue";
import DiffView from "./DiffView.js";
import ConflictEditor from "./ConflictEditor.js";

const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const refOf = (stash) => typeof stash === "string" ? stash : stash.ref || stash.name || stash.id || "stash@{0}";

export default defineComponent({
  name: "WorkspaceGitPanel",
  props: { status: Object, history: Array, historyEof: Boolean, commit: Object, files: Array, diff: String, diffTabs: Array, diffActive: String, conflict: Object, commitMessage: String, stash: String },
  emits: ["select-diff", "close-diff", "refresh", "write", "history", "history-next", "changes", "select-commit", "diff-file", "conflict", "delete-file", "resolve", "cancel-conflict", "update-conflict", "update:commitMessage", "update:stash"],
  setup(props, { emit }) {
    const btn = (label, action, disabled = false) => h("button", { type: "button", disabled: disabled || (!!props.status?.error && label !== "刷新"), onClick: action }, label);
    return () => {
      const status = props.status || { files: [], branches: [], stashes: [] };
      const hasConflict = (status.files || []).some((file) => CONFLICTS.has(`${file.indexStatus}${file.worktreeStatus}`));
      const operation = typeof status.operation === "string" ? status.operation : status.operation?.type || status.operation?.kind || "";
      const isMerge = /merge/i.test(operation), isRebase = /rebase/i.test(operation);
      return h("section", { class: "ws-git" }, [
        h("div", { class: "ws-toolbar" }, [h("strong", null, `Git · ${status.branch || "未初始化"}`), h("span", null, status.upstream || "无 upstream"), h("span", null, `↑${status.ahead || 0} ↓${status.behind || 0}`), btn("刷新", () => emit("refresh")), btn("Fetch", () => emit("write", "fetch")), btn("Pull", () => { const strategy = globalThis.prompt("拉取策略：merge / rebase / ff-only", "ff-only"); if (strategy) emit("write", "pull", { strategy }); }), btn("Push", () => emit("write", "push")), btn("历史", () => emit("history")), (props.commit || props.history?.length) && btn("返回变更", () => emit("changes")), props.history?.length > 0 && !props.commit && btn("较早记录", () => emit("history-next"), props.historyEof)]),
        status.error ? h("p", { class: "ws-error" }, status.error) : null,
        props.conflict ? h(ConflictEditor, { conflict: props.conflict, onUpdateResult: (value) => emit("update-conflict", value), onSave: (side) => emit("resolve", side), onCancel: () => emit("cancel-conflict") }) : null,
        props.history?.length ? h("div", { class: "ws-git-list" }, props.history.map((item) => h("button", { class: "ws-entry", onClick: () => emit("select-commit", item) }, `${item.id.slice(0, 8)} · ${item.subject} · ${item.author}`))) : null,
        props.commit ? h("div", { class: "ws-git-list" }, [h("strong", null, `${props.commit.id.slice(0, 8)} ${props.commit.subject}`), ...(props.files || []).map((item) => h("div", { class: "ws-git-row" }, [h("span", null, item.status), h("code", null, item.path), btn("查看差异", () => emit("diff-file", item.path, "commit"))]))]) : null,
        h("nav", { class: "ws-file-tabs" }, (props.diffTabs || []).map(tab => h("span", { key: tab.id, class: ["ws-file-tab", tab.id === props.diffActive && "active"] }, [h("button", { onClick: () => emit("select-diff", tab.id) }, tab.label), h("button", { "aria-label": `关闭 ${tab.label}`, onClick: () => emit("close-diff", tab.id) }, "×")]))),
        props.diff ? h(DiffView, { patch: props.diff }) : null,
        !props.history?.length && !props.commit && !props.conflict ? h("div", { class: "ws-git-list" }, [
          btn("全部暂存", () => emit("write", "stage", { paths: (status.files || []).map((item) => item.path) })), btn("全部取消暂存", () => emit("write", "unstage", { paths: (status.files || []).map((item) => item.path) })),
          ...(status.files || []).map((item) => { const code = `${item.indexStatus}${item.worktreeStatus}`, untracked = item.indexStatus === "?" || item.worktreeStatus === "?" || code === "??"; return h("div", { class: "ws-git-row" }, [h("span", null, code), h("code", null, item.path), btn("工作区差异", () => emit("diff-file", item.path, "worktree")), btn("暂存区差异", () => emit("diff-file", item.path, "staged")), btn("暂存", () => emit("write", "stage", { paths: [item.path] })), btn("取消暂存", () => emit("write", "unstage", { paths: [item.path] })), CONFLICTS.has(code) ? btn("解决冲突", () => emit("conflict", item.path)) : null, untracked ? btn("删除未跟踪文件", () => emit("delete-file", item.path)) : null, !untracked && btn("丢弃", () => emit("write", "discard", { paths: [item.path] }))]); }),
        ]) : null,
        h("div", { class: "ws-git-actions" }, [h("input", { placeholder: "提交说明", value: props.commitMessage, disabled: !!status.error, onInput: (event) => emit("update:commitMessage", event.target.value) }), btn("提交", () => emit("write", "commit", { message: props.commitMessage })), btn("新建分支", () => { const branch = globalThis.prompt("分支名称"); if (branch) emit("write", "branch_create", { branch }); }), h("select", { disabled: !!status.error, onChange: (event) => event.target.value && emit("write", "switch", { branch: event.target.value }) }, [h("option", { value: "" }, "切换分支"), ...(status.branches || []).map((branch) => h("option", { value: typeof branch === "string" ? branch : branch.name }, typeof branch === "string" ? branch : branch.name))]),
          h("select", { value: props.stash || "", disabled: !!status.error, onChange: (event) => emit("update:stash", event.target.value) }, [h("option", { value: "" }, "选择 stash"), ...(status.stashes || []).map((stash) => h("option", { value: refOf(stash) }, refOf(stash)))]), btn("Stash", () => emit("write", "stash_create")), btn("应用", () => props.stash && emit("write", "stash_apply", { stash: props.stash }), !props.stash), btn("弹出", () => props.stash && emit("write", "stash_pop", { stash: props.stash }), !props.stash), btn("删除 stash", () => props.stash && emit("write", "stash_drop", { stash: props.stash }), !props.stash),
          isMerge ? btn("继续合并", () => emit("write", "merge_continue"), hasConflict) : null, isMerge ? btn("中止合并", () => emit("write", "merge_abort")) : null, isRebase ? btn("继续变基", () => emit("write", "rebase_continue"), hasConflict) : null, isRebase ? btn("中止变基", () => emit("write", "rebase_abort")) : null,
        ]),
      ]);
    };
  },
});
