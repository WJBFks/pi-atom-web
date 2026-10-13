import { defineComponent, h, onMounted, onUnmounted, ref, watch, computed } from "vue";
import { useWorkspaceStore } from "../../stores/workspace.js";
import FileTree from "./FileTree.js";
import FileEditor from "./FileEditor.js";
import GitPanel from "./GitPanel.js";
import DiffView from "./DiffView.js";
import { readPanelPreference, writePanelPreference } from "./panel-preferences.js";

export default defineComponent({
  name: "WorkspacePanel",
  props: { token: String, sessionId: String, payload: Object, active: Boolean, onClose: Function, onError: Function },
  emits: ["tabs-change"],
  setup(props, { emit, expose }) {
    const store = useWorkspaceStore();
    const pane = ref("files"), selected = ref(null), file = ref(null), fileTabs = ref([]), drafts = ref({}), expanded = ref(new Set()), hidden = ref(true), ignored = ref(true), query = ref(""), searchEntries = ref(null), searchTruncated = ref(false), offset = ref(1), eof = ref(true), editing = ref(false), git = ref(null), history = ref([]), commit = ref(null), commitFiles = ref([]), diff = ref(""), saveConflict = ref(null), conflict = ref(null), commitMessage = ref(""), message = ref(""), loading = ref(false);
    let pollTimer, searchTimer, searchSequence = 0, readSequence = 0, currentSession = props.sessionId;
    const savedSessions = new Map();
    const treeTruncated = ref(false);
    const treeLayout = ref(null), treeWidth = ref(null);
    let stopTreeResize;
    try { const saved = Number(localStorage.getItem("atom-workspace-tree-width")); if (saved >= 120) treeWidth.value = saved; } catch {}
    const saveTreeWidth = () => { try { localStorage.setItem("atom-workspace-tree-width", String(Math.round(treeWidth.value))); } catch {} };
    const clampTreeWidth = value => Math.max(120, Math.min(value, (treeLayout.value?.clientWidth || 500) - 166));
    const startTreeResize = event => {
      if (event.button !== 0 || !treeLayout.value) return;
      event.preventDefault(); stopTreeResize?.();
      const rect = treeLayout.value.getBoundingClientRect();
      const move = next => { treeWidth.value = clampTreeWidth(next.clientX - rect.left); };
      const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.classList.remove("is-resizing"); if (treeWidth.value) saveTreeWidth(); stopTreeResize = null; };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); document.body.classList.add("is-resizing"); stopTreeResize = stop;
    };
    const resizeTreeKey = event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = treeWidth.value || treeLayout.value.clientWidth * .32; treeWidth.value = clampTreeWidth(event.key === "Home" ? 120 : event.key === "End" ? treeLayout.value.clientWidth : current + (event.key === "ArrowRight" ? 16 : -16)); saveTreeWidth(); };
    onUnmounted(() => stopTreeResize?.());
    const gitOpen = ref(false), newTabOpen = ref(false);
    const directoryOpen = ref(true), pinned = ref(new Set()), activeDocument = ref(null), quickFile = ref(null);
    let viewReady = false;
    watch(() => [store.root, pane.value, directoryOpen.value, gitOpen.value, newTabOpen.value, [...pinned.value], activeDocument.value, quickFile.value?.path], () => { if (viewReady) writePanelPreference("workspace", props.sessionId, { root: store.root, pane: pane.value, directory: directoryOpen.value, git: gitOpen.value, newTab: newTabOpen.value, files: [...pinned.value], active: activeDocument.value, preview: quickFile.value?.path || null }); }, { deep: true });
    const syncSelectedFile = target => { file.value = target; eof.value = !!target?.eof; offset.value = target?.nextOffset ?? 1; editing.value = false; };
    const selectTopTab = id => { if (id === "new") { newTabOpen.value = true; pane.value = "new"; activeDocument.value = null; return; } if (id === "git") { gitOpen.value = true; pane.value = "git"; activeDocument.value = null; refreshGit().catch(fail); return; } if (id === "directory") { pane.value = "files"; directoryOpen.value = true; activeDocument.value = null; syncSelectedFile(quickFile.value); } else { const path = id.slice(5), tab = fileTabs.value.find(item => item.path === path); if (tab) { pane.value = "files"; activeDocument.value = path; syncSelectedFile(tab); } } };
    const pinPreview = () => { if (!file.value) return; pinned.value = new Set(pinned.value).add(file.value.path); activeDocument.value = file.value.path; };
    watch(() => store.root, () => { pinned.value = new Set(); activeDocument.value = null; quickFile.value = null; directoryOpen.value = true; }, { flush: "sync" });
    watch(() => [directoryOpen.value, gitOpen.value, newTabOpen.value, pane.value, [...pinned.value], activeDocument.value, Object.keys(drafts.value)], () => emit("tabs-change", { tabs: [...(directoryOpen.value ? [{ id: "directory", label: "文件管理器" }] : []), ...(gitOpen.value ? [{ id: "git", label: "Git" }] : []), ...(newTabOpen.value ? [{ id: "new", label: "新标签页" }] : []), ...[...pinned.value].map(path => ({ id: `file:${path}`, label: `${path}${dirty(path) ? " •" : ""}` }))], active: pane.value === "git" ? "git" : pane.value === "new" ? "new" : activeDocument.value ? `file:${activeDocument.value}` : "directory" }), { deep: true, immediate: true });
    const dirty = (path) => Object.hasOwn(drafts.value, path);
    const changedPaths = computed(() => {
      const files = git.value?.files || [];
      if (store.root === "repo") return files.map((item) => item.path.replace(/\\/g, "/"));
      const cwd = String(store.info?.roots?.cwd || "").replace(/\\/g, "/").replace(/\/$/, "");
      const repo = String(store.info?.roots?.repo || "").replace(/\\/g, "/").replace(/\/$/, "");
      const prefix = cwd.startsWith(`${repo}/`) ? cwd.slice(repo.length + 1) : "";
      return files.map((item) => item.path.replace(/\\/g, "/")).filter((path) => !prefix || path === prefix || path.startsWith(`${prefix}/`)).map((path) => prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path === prefix ? "" : path);
    });
    const treeGitStatuses = computed(() => {
      const roots = store.info?.roots || {}, repo = String(roots.repo || "").replace(/\\/g, "/").replace(/\/$/, ""), cwd = String(roots.cwd || "").replace(/\\/g, "/").replace(/\/$/, "");
      const prefix = store.root === "cwd" && cwd.startsWith(`${repo}/`) ? cwd.slice(repo.length + 1) + "/" : "";
      return Object.fromEntries((git.value?.files || []).filter(item => !prefix || item.path.startsWith(prefix)).map(item => [prefix ? item.path.slice(prefix.length) : item.path, `${item.indexStatus}${item.worktreeStatus}`]));
    });
    const fail = (error) => { if (error.name === "AbortError") return; message.value = error.message; props.onError?.(error.message); };
    let foregroundRequests = 0, loadingTimer;
    const request = async (op, params = {}, { silent = false } = {}) => {
      if (!silent && foregroundRequests++ === 0) loadingTimer = setTimeout(() => { loading.value = true; }, 250);
      try { return await store.request(op, params); }
      catch (error) { fail(error); throw error; }
      finally { if (!silent && --foregroundRequests === 0) { clearTimeout(loadingTimer); loading.value = false; } }
    };
    const refreshTree = async (path = "", options = {}) => { const result = await request("list", { root: store.root, path, hidden: hidden.value, ignored: ignored.value }, options); if (!path) { store.tree = result.entries || []; treeTruncated.value = !!result.truncated; } return result.entries || []; };
    const refreshGit = async () => { if (!props.active || document.visibilityState !== "visible") return; try { git.value = await store.refreshGit(); } catch (error) { if (error.name !== "AbortError") git.value = { files: [], branches: [], stashes: [], error: error.message }; } };
    const targets = () => [...new Set(["", ...pinned.value, ...(quickFile.value ? [quickFile.value.path] : []), ...expanded.value])].map(path => ({ root: store.root, path }));
    const readFile = async (entry, { bypassGuard = false, startLine = 1 } = {}) => {
      const sequence = ++readSequence, root = store.root;
      selected.value = entry;
      directoryOpen.value = true; activeDocument.value = null;
      fileTabs.value = fileTabs.value.filter(tab => tab.path === entry.path || pinned.value.has(tab.path) || dirty(tab.path));
      const cached = fileTabs.value.find((item) => item.path === entry.path);
      if (cached) { cached.focusLine = startLine; quickFile.value = cached; syncSelectedFile(cached); store.setWatchTargets(targets()); return; }
      const result = await request("read", { root: store.root, path: entry.path, offset: startLine, limit: 500 });
      if (sequence !== readSequence || root !== store.root) return;
      result.startLine = result.offset || startLine; result.focusLine = startLine; file.value = result; fileTabs.value.push(result); offset.value = result.nextOffset ?? result.offset ?? startLine; eof.value = !!result.eof; editing.value = false; message.value = result.reason || "";
      quickFile.value = result;
      store.setWatchTargets(targets());
    };
    const openAbsolute = async (detail = {}) => {
      await store.open();
      const path = String(detail.path || "");
      const roots = store.info?.roots || {};
      const normalizePath = (value) => String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
      const normalizedPath = normalizePath(path);
      const key = value => /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
      const pathKey = key(normalizedPath);
      const candidates = ["cwd", "repo"].map((root) => [root, String(roots[root] || "")]).map(([root, base]) => [root, base, normalizePath(base)]).filter(([, base, normalized]) => base && (pathKey === key(normalized) || pathKey.startsWith(`${key(normalized)}/`))).sort((a, b) => b[2].length - a[2].length);
      if (candidates.length) {
        const nextRoot = candidates[0][0];
        if (nextRoot !== store.root) {
          if (Object.keys(drafts.value).length) { message.value = "路径位于另一个工作区根目录；请先保存或丢弃当前草稿。"; return; }
          store.root = nextRoot; fileTabs.value = []; file.value = null; selected.value = null; expanded.value = new Set(); searchEntries.value = null;
        }
        const relative = normalizedPath.slice(candidates[0][2].length).replace(/^\/+/, "");
        const entry = { path: relative, name: relative.split(/[\\/]/).pop() };
        await refreshTree();
        await readFile(entry, { bypassGuard: true, startLine: Math.max(1, Number(detail.line) || 1) });
      } else if (path && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path)) {
        if (store.root !== "cwd") {
          if (Object.keys(drafts.value).length) { message.value = "相对路径属于当前目录根；请先保存或丢弃现有草稿。"; return; }
          store.root = "cwd"; fileTabs.value = []; file.value = null; selected.value = null; expanded.value = new Set(); searchEntries.value = null;
        }
        const entry = { path, name: path.split(/[\\/]/).pop() }; await refreshTree(); await readFile(entry, { bypassGuard: true, startLine: Math.max(1, Number(detail.line) || 1) });
      }
    };
    const expand = async (entry) => {
      if (expanded.value.has(entry.path)) { expanded.value = new Set([...expanded.value].filter((path) => path !== entry.path)); entry.children = null; }
      else { expanded.value = new Set(expanded.value).add(entry.path); entry.children = await refreshTree(entry.path); }
      store.setWatchTargets(targets());
    };
    const loadMore = async () => {
      const previous = file.value, root = store.root;
      const next = await request("read", { root, path: previous.path, offset: previous.nextOffset ?? offset.value, limit: 500 });
      if (file.value?.path !== previous.path || store.root !== root) return;
      if (next.version !== previous.version) { message.value = "文件已被外部修改，请重载后继续分页。"; return; }
      file.value = { ...file.value, text: `${file.value.text}${file.value.text && !file.value.text.endsWith("\n") ? "\n" : ""}${next.text}`, nextOffset: next.nextOffset, eof: next.eof, editable: file.value.editable && next.editable };
      Object.assign(fileTabs.value.find((tab) => tab.path === file.value.path), file.value); offset.value = next.nextOffset ?? next.offset; eof.value = next.eof;
    };
    const readComplete = async (path) => {
      const result = await request("read", { root: store.root, path, offset: 1, limit: 500 });
      if (!result.editable) throw new Error("磁盘文件已变为大文件或二进制；草稿已保留，请下载或重载后处理。");
      return result;
    };
    const save = async (force = false) => {
      if (!file.value?.editable || !dirty(file.value.path)) return;
      const target = file.value, root = store.root, text = drafts.value[target.path];
      if (saveConflict.value && saveConflict.value.path !== file.value.path) saveConflict.value = null;
      const baseVersion = saveConflict.value?.version || file.value.version;
      if (force && !globalThis.confirm(`确认覆盖“${file.value.path}”？\n${store.root === "repo" ? store.info?.repositoryRoot : store.info?.cwd || ""}`)) return;
      try {
        const result = await request("save", { root, path: target.path, text, version: baseVersion, ...(force ? { force: true } : {}) });
        if (root !== store.root) return;
        const tab = fileTabs.value.find(item => item.path === result.path); if (tab) Object.assign(tab, result);
        if (file.value?.path === target.path) file.value = tab || result;
        if (drafts.value[result.path] === text) delete drafts.value[result.path]; saveConflict.value = null; message.value = "已保存";
      } catch (error) {
      if (error.status === 409 && !force && root === store.root) {
          const external = await readComplete(target.path);
          const oldLines = String(external.text || "").split("\n"), newLines = String(drafts.value[target.path] || "").split("\n");
          saveConflict.value = { path: target.path, version: external.version, diskText: external.text, draft: drafts.value[target.path], patch: `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}`).join("\n")}\n${newLines.map((line) => `+${line}`).join("\n")}` };
        }
      }
    };
    const reloadExternal = () => { if (!saveConflict.value || saveConflict.value.path !== file.value?.path) return; file.value = { ...file.value, text: saveConflict.value.diskText, version: saveConflict.value.version }; Object.assign(fileTabs.value.find((tab) => tab.path === file.value.path), file.value); delete drafts.value[file.value.path]; saveConflict.value = null; };
    const reload = async () => { if (file.value && (!dirty(file.value.path) || globalThis.confirm(`丢弃“${file.value.path}”的草稿并重载？`))) { delete drafts.value[file.value.path]; fileTabs.value = fileTabs.value.filter((tab) => tab.path !== file.value.path); file.value = null; await readFile(selected.value, { bypassGuard: true }); } };
    const closeTab = async (path) => {
      if (dirty(path)) {
        const choice = globalThis.prompt(`“${path}”有未保存草稿：输入 save、discard 或 cancel`, "cancel");
        if (choice === "cancel" || !choice) return;
        if (choice === "save") { const previous = file.value; file.value = fileTabs.value.find((item) => item.path === path); await save(); file.value = previous; if (dirty(path)) return; }
        else if (choice === "discard") delete drafts.value[path]; else return;
      }
      fileTabs.value = fileTabs.value.filter((item) => item.path !== path);
      pinned.value = new Set([...pinned.value].filter(item => item !== path));
      if (quickFile.value?.path === path) quickFile.value = null;
      if (activeDocument.value === path) { const next = [...pinned.value].at(-1); activeDocument.value = next || null; syncSelectedFile(next ? fileTabs.value.find(item => item.path === next) : quickFile.value); }
      else if (file.value?.path === path) syncSelectedFile(quickFile.value);
      store.setWatchTargets(targets());
    };
    const fallbackTab = () => { if (directoryOpen.value) selectTopTab("directory"); else if (gitOpen.value) selectTopTab("git"); else if (pinned.value.size) selectTopTab(`file:${[...pinned.value][0]}`); else if (newTabOpen.value) selectTopTab("new"); };
    const choosePage = id => { selectTopTab(id); newTabOpen.value = false; };
    const closeTopTab = async id => {
      const current = pane.value === "git" ? "git" : pane.value === "new" ? "new" : activeDocument.value ? "file:" + activeDocument.value : "directory";
      if (id === "new") newTabOpen.value = false;
      else if (id === "git") gitOpen.value = false;
      else if (id === "directory") directoryOpen.value = false;
      else { await closeTab(id.slice(5)); return; }
      if (current === id) fallbackTab();
    };
    expose({ newTab: () => selectTopTab("new"), selectTab: selectTopTab, closeTab: id => closeTopTab(id).catch(fail), resume: () => { if (!directoryOpen.value && !gitOpen.value && !newTabOpen.value && !pinned.value.size) selectTopTab("directory"); } });
    const create = async (directory) => { const base = selected.value?.directory ? `${selected.value.path.replace(/[\\/]$/, "")}/` : ""; const name = globalThis.prompt(directory ? "新目录名称" : "新文件名称"); if (name) { const path = `${base}${name}`; await request("create", { root: store.root, path, directory, text: "" }); await refreshTree(); } };
    const containsPath = (base, path) => path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
    const forgetPaths = (base) => { fileTabs.value = fileTabs.value.filter(tab => !containsPath(base, tab.path)); pinned.value = new Set([...pinned.value].filter(path => !containsPath(base, path))); if (quickFile.value && containsPath(base, quickFile.value.path)) quickFile.value = null; if (activeDocument.value && containsPath(base, activeDocument.value)) { const next = [...pinned.value].at(-1); activeDocument.value = next || null; syncSelectedFile(next ? fileTabs.value.find(tab => tab.path === next) : quickFile.value); } else if (file.value && containsPath(base, file.value.path)) file.value = null; selected.value = null; expanded.value = new Set([...expanded.value].filter(path => !containsPath(base, path))); store.setWatchTargets(targets()); };
    const renameDialog = ref(null), renameName = ref(""), renameError = ref(""), renameBusy = ref(false);
    const moveEntry = async (entry) => { renameDialog.value = entry; renameName.value = entry.path.split("/").pop(); renameError.value = ""; };
    const confirmRename = async () => {
      const entry = renameDialog.value, name = renameName.value;
      if (!entry || renameBusy.value) return;
      if (!name.trim() || name === "." || name === ".." || /[\\/]/.test(name)) { renameError.value = "请输入当前目录下的名称，不可包含路径分隔符。"; return; }
      if (Object.keys(drafts.value).some(path => containsPath(entry.path, path))) { renameError.value = "请先保存或丢弃此路径下的草稿。"; return; }
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
      if (parent + name === entry.path) { renameDialog.value = null; return; }
      renameBusy.value = true;
      try { await request("rename", { root: store.root, path: entry.path, target: parent + name }); forgetPaths(entry.path); await refreshTree(); renameDialog.value = null; } catch (error) { renameError.value = error.message; } finally { renameBusy.value = false; }
    };
    const deleteEntry = async (entry) => {
      const descendants = Object.keys(drafts.value).filter((path) => path === entry.path || path.startsWith(`${entry.path}/`) || path.startsWith(`${entry.path}\\`));
      if (descendants.length && !globalThis.confirm(`目录下有未保存草稿：\n${descendants.join("\n")}\n继续删除并丢弃这些草稿？`)) return;
      if (globalThis.confirm(`确定删除目录“${entry.path}”？\n${store.root === "repo" ? store.info?.repositoryRoot : store.info?.cwd || ""}`)) { await request("delete", { root: store.root, path: entry.path, confirmed: true }); for (const path of descendants) delete drafts.value[path]; forgetPaths(entry.path); await refreshTree(); }
    };
    const rename = async () => {
      const path = file.value?.path; if (!path) return;
      if (dirty(path)) { message.value = "请先保存或丢弃该文件草稿，再移动/重命名。"; return; }
      const target = globalThis.prompt("移动/重命名为", path);
      if (target && target !== path) { await request("rename", { root: store.root, path, target }); forgetPaths(path); await refreshTree(); }
    };
    const remove = async () => {
      const path = file.value?.path; if (!path) return;
      if (dirty(path)) {
        const choice = globalThis.prompt(`“${path}”有未保存草稿：输入 save、discard 或 cancel`, "cancel");
        if (choice === "save") await save(); else if (choice === "discard") delete drafts.value[path]; else return;
        if (dirty(path)) return;
      }
      if (globalThis.confirm(`确定删除“${path}”？\n${store.root === "repo" ? store.info?.repositoryRoot : store.info?.cwd || ""}`)) { await request("delete", { root: store.root, path, confirmed: true }); forgetPaths(path); await refreshTree(); }
    };
    const download = async () => { try { const result = await request("download", { root: store.root, path: file.value.path }); const link = document.createElement("a"); link.href = result.data.startsWith("data:") ? result.data : `data:${result.mime || "application/octet-stream"};base64,${result.data}`; link.download = result.name; link.click(); } catch {} };
    const gitWrite = async (command, params = {}) => {
      const critical = new Set(["commit", "pull", "push", "discard", "branch_create", "stash_create", "stash_apply", "stash_pop", "stash_drop", "switch", "merge_continue", "merge_abort", "rebase_continue", "rebase_abort"]);
      const dangerous = critical.has(command);
      const paths = params.paths?.join(", ") || params.branch || params.stash || "当前仓库";
      if (dangerous && !globalThis.confirm(`确认执行 Git 操作 ${command}？\n路径/目标：${paths}\n仓库：${store.info?.repositoryRoot || store.info?.cwd || ""}`)) return;
      await request("git_write", { command, revision: git.value?.revision, ...params, ...(dangerous ? { confirmed: true } : {}) });
      await refreshGit();
    };
    const gitDiff = async (path, kind = "worktree", commitId) => { const result = await request("git_diff", { path, kind, ...(commitId ? { commit: commitId } : {}) }); const id = `${kind}:${commitId || ""}:${path}`; const tab = { id, path, kind, commitId, patch: result.patch || "", label: `${kind === "staged" ? "已暂存" : kind === "commit" ? commitId.slice(0,8) : "未暂存"} · ${path}` }; const index = diffTabs.value.findIndex(item => item.id === id); if (index < 0) diffTabs.value.push(tab); else diffTabs.value[index] = tab; diffActive.value = id; diff.value = tab.patch; };
    const diffTabs = ref([]), diffActive = ref(null);
    const historyOffset = ref(0), historyEof = ref(false), stashRef = ref("");
    const loadHistory = async (append = false) => { const result = await request("git_history", { offset: append ? historyOffset.value : 0, limit: 50 }); history.value = append ? [...history.value, ...(result.commits || [])] : result.commits || []; historyOffset.value = append ? historyOffset.value + (result.commits || []).length : (result.commits || []).length; historyEof.value = !!result.eof; commit.value = null; commitFiles.value = []; diff.value = ""; };
    const selectCommit = async (item) => { commit.value = item; const result = await request("git_commit_files", { commit: item.id }); commitFiles.value = result.files || []; diff.value = ""; };
    const showConflict = async (path) => { conflict.value = { ...(await request("git_conflict", { path })), path }; };
    const resolveConflict = async (side) => { if (!conflict.value) return; const params = { path: conflict.value.path, version: conflict.value.version, ...(side ? { side } : { text: conflict.value.result }) }; if (!globalThis.confirm(`确认采用${side === "ours" ? "本地版本" : side === "theirs" ? "对方版本" : "当前合并结果"}并暂存“${conflict.value.path}”？`)) return; await request("git_resolve", params); conflict.value = null; await refreshGit(); };
    const closePanel = () => props.onClose?.();
    let invalidationFlight, invalidationAgain = false;
    const invalidate = () => {
      if (!props.active || document.visibilityState !== "visible") return Promise.resolve();
      if (invalidationFlight) { invalidationAgain = true; return invalidationFlight; }
      invalidationFlight = (async () => {
      const changes = store.invalidatedTargets; store.invalidatedTargets = [];
      const affected = path => !changes.length || changes.some(target => target.root === store.root && (containsPath(path, target.path) || containsPath(target.path, path) || !path || !target.path));
      const cachedChildren = new Map();
      const cache = list => { for (const entry of list || []) { if (entry.children) { cachedChildren.set(entry.path, entry.children); cache(entry.children); } } }; cache(store.tree);
      if (affected("")) await refreshTree("", { silent: true });
      for (const path of expanded.value) { const entries = affected(path) ? await refreshTree(path, { silent: true }) : cachedChildren.get(path); const find = (list) => { for (const entry of list || []) { if (entry.path === path) { if (entries) entry.children = entries; return true; } if (find(entry.children)) return true; } return false; }; find(store.tree); }
      const activePath = file.value?.path;
      for (const tab of fileTabs.value) {
        if (dirty(tab.path) || !affected(tab.path)) continue;
        let updated;
        try { updated = await request("read", { root: store.root, path: tab.path, offset: tab.startLine || 1, limit: 500 }, { silent: true }); } catch (error) { if (error.status === 404) { tab.reason = "文件已被外部删除；原预览暂时保留。"; continue; } throw error; }
        if (updated.version === tab.version) continue;
        Object.assign(tab, updated, { startLine: updated.offset || 1 });
        if (tab.path === activePath) { offset.value = updated.nextOffset ?? 1; eof.value = !!updated.eof; }
        if (tab.path === activePath) file.value = tab;
      }
      await refreshGit();
      })().finally(() => { invalidationFlight = null; if (invalidationAgain) { invalidationAgain = false; invalidate().catch(fail); } });
      return invalidationFlight;
    };
    const beforeUnload = (event) => { if (Object.keys(drafts.value).length || [...savedSessions.values()].some(state => Object.keys(state.drafts).length)) { event.preventDefault(); event.returnValue = ""; } };
    const resetForSession = async () => {
      viewReady = false;
      readSequence++; searchSequence++; clearTimeout(searchTimer);
      savedSessions.set(currentSession, { root: store.root, drafts: drafts.value, tabs: fileTabs.value });
      store.close(); currentSession = props.sessionId; store.configure(props.token, props.sessionId);
      const previous = savedSessions.get(currentSession);
      drafts.value = previous?.drafts || {}; fileTabs.value = previous?.tabs || []; store.root = previous?.root || "cwd";
      file.value = null; quickFile.value = null; pinned.value = new Set(); activeDocument.value = null; directoryOpen.value = true; selected.value = null; expanded.value = new Set(); store.watchTargets = []; store.info = null;
      diffTabs.value = []; diffActive.value = null; git.value = null; history.value = []; commit.value = null; diff.value = ""; conflict.value = null; saveConflict.value = null;
      await store.open(); await restoreView(); if (props.active) { await refreshTree(); await refreshGit(); } else store.close();
    };
    watch(() => props.sessionId, () => resetForSession().catch(fail));
    watch(() => props.token, () => { store.configure(props.token, props.sessionId); if (props.active) store.open().catch(fail); });
    watch(() => props.active, (active) => { clearInterval(pollTimer); if (!active) { store.close(); } else { store.open().then(() => invalidate()).catch(fail); pollTimer = setInterval(() => { if (props.active && document.visibilityState === "visible") { refreshGit().catch(() => {}); if (!store.watchId) store.startWatch().catch(() => {}); } }, 5000); } });
    watch(() => store.invalidateCount, () => invalidate().catch(fail));
    watch(() => props.payload, (payload) => { if (payload?.path) openAbsolute(payload).catch(fail); else selectTopTab("directory"); }, { deep: true });
    const onVisibility = () => {
      if (document.visibilityState !== "visible") store.stopWatch();
      else if (props.active) { store.startWatch().catch(fail); invalidate().catch(fail); }
    };
    const restoreView = async () => {
      const saved = readPanelPreference("workspace", props.sessionId);
      if (saved && typeof saved === "object") {
        store.root = saved.root === "repo" && store.info?.repositoryRoot ? "repo" : "cwd";
        for (const path of Array.isArray(saved.files) ? saved.files.filter(path => typeof path === "string") : []) {
          try { await readFile({ path }); pinned.value = new Set(pinned.value).add(path); } catch (error) { if (error.name === "AbortError") return; }
        }
        if (typeof saved.preview === "string") { try { await readFile({ path: saved.preview }); } catch {} }
        else quickFile.value = null;
        directoryOpen.value = saved.directory !== false;
        gitOpen.value = saved.git === true || saved.pane === "git"; newTabOpen.value = saved.newTab === true; pane.value = saved.pane === "git" ? "git" : saved.pane === "new" && newTabOpen.value ? "new" : "files";
        if (pane.value === "files" && pinned.value.has(saved.active)) selectTopTab(`file:${saved.active}`);
        else { activeDocument.value = null; syncSelectedFile(quickFile.value); if (pane.value === "files" && !directoryOpen.value && pinned.value.size) selectTopTab(`file:${[...pinned.value][0]}`); }
      }
      viewReady = true;
    };
    onMounted(async () => {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("beforeunload", beforeUnload);
      store.configure(props.token, props.sessionId);
      try { await store.open(); await restoreView(); if (props.active) { await refreshTree(); await refreshGit(); if (props.payload?.path) await openAbsolute(props.payload); } else store.close(); }
      catch (error) { fail(error); }
      pollTimer = setInterval(() => { if (props.active && document.visibilityState === "visible") { refreshGit().catch(() => {}); if (!store.watchId) store.startWatch().catch(() => {}); } }, 5000);
    });
    onUnmounted(() => { clearInterval(pollTimer); clearTimeout(searchTimer); clearTimeout(loadingTimer); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("beforeunload", beforeUnload); store.close(); });
    const onSearch = (event) => {
      query.value = event.target.value; clearTimeout(searchTimer); const sequence = ++searchSequence;
      searchTimer = setTimeout(async () => { try { if (!query.value) { searchEntries.value = null; searchTruncated.value = false; return; } const result = await request("search", { root: store.root, path: "", hidden: hidden.value, ignored: ignored.value, query: query.value }); if (sequence === searchSequence) { searchEntries.value = result.entries || []; searchTruncated.value = !!result.truncated; } } catch (error) { fail(error); } }, 250);
    };
    const canSwitchRoot = computed(() => {
      const normalize = path => { const value = String(path || "").replace(/\\/g, "/").replace(/\/$/, ""); return /^[a-z]:/i.test(value) ? value.toLowerCase() : value; };
      return !!store.info?.repositoryRoot && normalize(store.info.cwd) !== normalize(store.info.repositoryRoot);
    });
    const changeRoot = async (event) => { if (Object.keys(drafts.value).length) { message.value = "请先保存或丢弃当前根目录的草稿，再切换根目录。"; event.target.value = store.root; return; } quickFile.value = null; pinned.value = new Set(); activeDocument.value = null; store.root = event.target.value; expanded.value = new Set(); fileTabs.value = []; file.value = null; selected.value = null; searchEntries.value = null; await refreshTree(); store.setWatchTargets(targets()); };
    return () => h("div", { class: "workspace-panel" }, [
      !activeDocument.value && pane.value === "files" && h("header", { class: "ws-bar" }, [h("strong", null, "工作区"), canSwitchRoot.value && h("select", { value: store.root, onChange: changeRoot }, [h("option", { value: "cwd" }, "当前目录"), h("option", { value: "repo", disabled: !store.info?.repositoryRoot }, "仓库根目录")]), h("input", { class: "ws-path-search", placeholder: "搜索路径", value: query.value, onInput: onSearch }), ]),
      pane.value === "new" ? h("div", { class: "ws-new-tab" }, [h("h2", null, "新标签页"), h("button", { onClick: () => choosePage("directory") }, "文件管理器"), h("button", { onClick: () => choosePage("git") }, "Git")]) : pane.value === "files" ? h("div", { ref: treeLayout, style: { "--ws-tree-width": treeWidth.value ? `${treeWidth.value}px` : "32%" }, class: ["ws-main", activeDocument.value && "ws-document"] }, [
        !activeDocument.value && h("aside", { class: "ws-files" }, [
          treeTruncated.value || searchTruncated.value ? h("p", { class: "ws-warning" }, "结果已截断；可缩小搜索范围或展开具体目录。") : null,
          h(FileTree, { onCreateFile: () => create(false).catch(fail), onCreateDirectory: () => create(true).catch(fail), entries: searchEntries.value || store.tree, rootPath: store.info?.roots?.[store.root], gitStatuses: treeGitStatuses.value, activePath: selected.value?.path, expanded: expanded.value, changedPaths: changedPaths.value, onSelect: (entry) => readFile(entry).catch(fail), onSelectDir: (entry) => selected.value = entry, onExpand: (entry) => expand(entry).catch(fail), onRename: (entry) => moveEntry(entry).catch(fail), onDelete: (entry) => deleteEntry(entry).catch(fail) }),
        ]),
        !activeDocument.value && h("div", { class: "ws-tree-divider", role: "separator", tabindex: 0, "aria-label": "调整目录树宽度", "aria-orientation": "vertical", onPointerdown: startTreeResize, onKeydown: resizeTreeKey }),
        h("section", { class: "ws-editor" }, [
          saveConflict.value && saveConflict.value.path === file.value?.path ? h("section", { class: "ws-save-conflict" }, [h("h3", null, `磁盘版本与草稿冲突：${file.value?.path}`), h(DiffView, { patch: saveConflict.value.patch }), h("button", { onClick: reloadExternal }, "重新加载磁盘版本"), h("button", { onClick: () => save(true).catch(fail) }, "确认覆盖磁盘版本"), h("button", { onClick: () => saveConflict.value = null }, "取消")]) : null,
          h(FileEditor, { quickPreview: !activeDocument.value, onOpenTab: pinPreview, file: file.value ? { ...file.value, editable: file.value.editable && eof.value } : null, text: file.value ? drafts.value[file.value.path] ?? file.value.text : "", editing: editing.value, dirty: file.value ? dirty(file.value.path) : false, eof: eof.value, startLine: file.value?.startLine || 1, onEdit: (value) => { drafts.value[file.value.path] = value; }, onToggleEdit: () => editing.value = !editing.value, onSave: () => save().catch(fail), onReload: () => reload().catch(fail), onForce: () => save(true).catch(fail), onRename: () => rename().catch(fail), onDelete: () => remove().catch(fail), onDownload: () => download().catch(fail), onNextPage: () => loadMore().catch(fail) }),
        ]),
      ]) : h(GitPanel, { status: git.value, history: history.value, historyEof: historyEof.value, commit: commit.value, files: commitFiles.value, diff: diff.value, diffTabs: diffTabs.value, diffActive: diffActive.value, onSelectDiff: id => { const tab = diffTabs.value.find(item => item.id === id); diffActive.value = id; diff.value = tab?.patch || ""; }, onCloseDiff: id => { diffTabs.value = diffTabs.value.filter(item => item.id !== id); if (id === diffActive.value) { const tab = diffTabs.value.at(-1); diffActive.value = tab?.id || null; diff.value = tab?.patch || ""; } }, conflict: conflict.value, commitMessage: commitMessage.value, stash: stashRef.value, onRefresh: () => refreshGit().catch(fail), onWrite: (command, params) => gitWrite(command, params).catch(fail), onHistory: () => loadHistory().catch(fail), onHistoryNext: () => loadHistory(true).catch(fail), onChanges: () => { history.value = []; commit.value = null; diff.value = ""; }, onSelectCommit: (item) => selectCommit(item).catch(fail), onDiffFile: (path, kind) => gitDiff(path, kind, commit.value?.id).catch(fail), onConflict: (path) => showConflict(path).catch(fail), onDeleteFile: async (path) => { if (globalThis.confirm(`删除未跟踪文件“${path}”？\n${store.info?.repositoryRoot || store.info?.cwd || ""}`)) { await request("delete", { root: "repo", path, confirmed: true }); await refreshGit(); } }, onResolve: (side) => resolveConflict(side).catch(fail), onCancelConflict: () => conflict.value = null, onUpdateConflict: (value) => { conflict.value.result = value; }, "onUpdate:commitMessage": (value) => commitMessage.value = value, "onUpdate:stash": (value) => stashRef.value = value }),
      renameDialog.value && h("div", { class: "ws-modal-backdrop", onKeydown: event => { if (event.key === "Escape" && !renameBusy.value) renameDialog.value = null; } }, [h("form", { class: "ws-rename-dialog", role: "dialog", "aria-modal": "true", "aria-label": "重命名", onSubmit: event => { event.preventDefault(); confirmRename(); } }, [h("strong", null, "重命名"), h("p", null, renameDialog.value.path), h("input", { value: renameName.value, "aria-label": "新名称", onInput: event => renameName.value = event.target.value, onVnodeMounted: vnode => { vnode.el.focus(); vnode.el.select(); } }), renameError.value && h("p", { role: "alert" }, renameError.value), h("div", { class: "ws-dialog-actions" }, [h("button", { type: "button", disabled: renameBusy.value, onClick: () => renameDialog.value = null }, "取消"), h("button", { type: "submit", disabled: renameBusy.value }, "确认")])])]),
      loading.value && h("div", { class: "ws-status" }, "处理中…"), message.value && h("div", { class: "ws-status" }, message.value), git.value?.error && h("div", { class: "ws-error" }, git.value.error),
    ]);
  },
});
