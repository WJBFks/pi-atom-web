import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { open, realpath, stat, lstat, readdir, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, extname, sep } from "node:path";

export const EDIT_BYTES = 2 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
export function workspaceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
const inside = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
const digest = (data) => createHash("sha256").update(data).digest("hex");
const mime = (path) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" })[extname(path).toLowerCase()] || "application/octet-stream";

export async function createFileService(cwd, repositoryRoot, ignoredPaths) {
  const roots = { cwd: await realpath(cwd), repo: repositoryRoot ? await realpath(repositoryRoot) : null };
  const watches = new Map();
  let writes = Promise.resolve();
  let closed = false;
  async function locate(input, creating = false) {
    if (closed) throw workspaceError("工作区服务已关闭", 409);
    const selectedRoot = input.root || "cwd";
    if (!["cwd", "repo"].includes(selectedRoot)) throw workspaceError("工作区根无效");
    const root = roots[selectedRoot];
    if (!root) throw workspaceError("工作区根不可用");
    if (typeof input.path !== "string" || input.path.includes("\0")) throw workspaceError("文件路径无效");
    const path = resolve(root, input.path || ".");
    if (!inside(root, path)) throw workspaceError("路径超出工作区", 403);
    const parts = relative(root, path).split(/[\\/]/);
    if (parts.some(p => p.toLowerCase() === ".git")) throw workspaceError("不允许访问 Git 内部目录", 403);
      const actual = creating ? resolve(await realpath(dirname(path)), basename(path)) : await realpath(path);
    if (!inside(root, actual)) throw workspaceError("链接目标超出工作区", 403);
    if (relative(root, actual).split(/[\\/]/).some(p => p.toLowerCase() === ".git")) throw workspaceError("不允许访问 Git 内部目录", 403);
    return { root, path, actual };
  }
  async function fileRead(input) {
    const { actual } = await locate(input);
    const handle = await open(actual, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw workspaceError("请选择普通文件");
      const offset = input.offset ?? 1, limit = input.limit ?? 500;
      if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw workspaceError("分页参数无效");
      let version = `${info.size}:${info.mtimeNs || info.mtimeMs}:${info.ino}`;
      const image = mime(actual).startsWith("image/");
      if (image && info.size <= EDIT_BYTES * 8) {
        const data = await handle.readFile();
        return { path: input.path, image: true, binary: true, data: `data:${mime(actual)};base64,${data.toString("base64")}`, bytes: info.size, version, editable: false, eof: true };
      }
      if (info.size <= EDIT_BYTES) {
        const data = await handle.readFile();
        version = digest(data);
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { text = null; }
        if (data.includes(0) || text === null) return { path: input.path, binary: true, image: false, bytes: info.size, version, editable: false, eof: true };
        return { path: input.path, text, offset: 1, eof: true, version, bytes: info.size, editable: true, binary: false, image: false };
      }
      // 顺序扫描到目标行，但仅保留当前页，避免巨文件进入内存。
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const buffer = Buffer.alloc(65536);
      let line = 1, pending = "", output = [], bytes = 0, position = 0, eof = false;
      while (output.length < limit && bytes < PAGE_BYTES) {
        const chunk = await handle.read(buffer, 0, buffer.length, position);
        position += chunk.bytesRead;
        if (!chunk.bytesRead) {
          eof = true;
          try { pending += decoder.decode(); } catch { return { path: input.path, binary: true, bytes: info.size, version, editable: false, eof: true }; }
          if (pending && line >= offset) {
            const length = Buffer.byteLength(pending);
            if (length > PAGE_BYTES) throw workspaceError("单行过长，请下载文件查看", 413);
            if (bytes + length + (output.length ? 1 : 0) > PAGE_BYTES) eof = false;
            else output.push(pending);
          }
          break;
        }
        if (buffer.subarray(0, chunk.bytesRead).includes(0)) return { path: input.path, binary: true, bytes: info.size, version, editable: false, eof: true };
        try { pending += decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true }); } catch { return { path: input.path, binary: true, bytes: info.size, version, editable: false, eof: true }; }
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0 && output.length < limit && bytes < PAGE_BYTES) {
          const value = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line++ >= offset) {
            const length = Buffer.byteLength(value);
            if (length > PAGE_BYTES) throw workspaceError("单行过长，请下载文件查看", 413);
            if (bytes + length + (output.length ? 1 : 0) > PAGE_BYTES) { bytes = PAGE_BYTES; break; }
            bytes += length + (output.length ? 1 : 0); output.push(value);
          }
        }
        if (pending.length > PAGE_BYTES) throw workspaceError("单行过长，请下载文件查看", 413);
      }
      return { path: input.path, text: output.join("\n"), offset, nextOffset: offset + output.length, eof, version, bytes: info.size, editable: false, binary: false, reason: "文件超过 2 MiB，使用只读分页以避免截断保存" };
    } finally { await handle.close(); }
  }
  async function request(input) {
    if (input.op === "read") return fileRead(input);
    if (input.op === "list" || input.op === "search") {
      const { root, actual } = await locate({ ...input, path: input.path || "." });
      const entries = [], queue = [actual]; let truncated = false, visited = 0;
      while (queue.length) {
        const dir = queue.shift();
        const children = await readdir(dir, { withFileTypes: true });
        const candidates = [];
        for (const entry of children) {
          if (entry.name.toLowerCase() === ".git") continue;
          const candidate = resolve(dir, entry.name);
          const target = await realpath(candidate).catch(() => null);
          if (target && inside(root, target) && !relative(root, target).split(/[\\/]/).some(part => part.toLowerCase() === ".git")) candidates.push(candidate);
        }
        const allowed = new Set(candidates);
        const ignored = new Set(repositoryRoot && ignoredPaths ? await ignoredPaths(candidates) : []);
        for (const entry of children) {
          if (++visited > 10000 || entries.length >= 1000) { truncated = true; break; }
          if (entry.name.toLowerCase() === ".git" || (!input.hidden && entry.name.startsWith("."))) continue;
          const candidate = resolve(dir, entry.name);
          if (!allowed.has(candidate)) continue;
          if (!input.ignored && ignored.has(candidate)) continue;
          let target; try { target = await realpath(candidate); } catch { continue; }
          if (!inside(root, target)) continue;
          const info = await stat(target).catch(() => null); if (!info) continue;
          const path = relative(root, candidate).split(sep).join("/");
          if (input.op === "list" || entry.name.toLowerCase().includes(String(input.query || "").toLowerCase())) entries.push({ name: entry.name, path, directory: info.isDirectory(), ignored: ignored.has(candidate) });
          if (input.op === "search" && entry.isDirectory()) queue.push(candidate);
        }
        if (truncated || input.op === "list") break;
      }
      entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return { entries, truncated };
    }
    if (input.op === "save") {
      if (typeof input.text !== "string" || Buffer.byteLength(input.text) > EDIT_BYTES) throw workspaceError("编辑内容超过 2 MiB", 413);
      const before = await fileRead(input);
      if (!before.editable) throw workspaceError("该文件不支持文本编辑");
      if (input.version !== before.version && input.force !== true) throw workspaceError("文件已被外部修改，请重新加载或确认覆盖", 409);
      const { actual } = await locate(input);
      await writeFile(actual, input.text, "utf8");
      return fileRead(input);
    }
    if (input.op === "create") {
      const { path } = await locate(input, true);
      if (input.directory) await mkdir(path); else await writeFile(path, typeof input.text === "string" ? input.text : "", { flag: "wx" });
      return { ok: true };
    }
    if (input.op === "rename" || input.op === "delete") {
      const { root, path } = await locate(input);
      if (path === root || Object.values(roots).some(r => r && inside(path, r))) throw workspaceError("不能删除或移动工作区根");
      if ((await lstat(path)).isSymbolicLink()) throw workspaceError("请在终端管理链接，避免操作其目标");
      if (input.op === "delete") {
        if (input.confirmed !== true) throw workspaceError("删除需要确认");
        await rm(path, { recursive: true });
      } else {
        const target = await locate({ ...input, path: input.target }, true);
        if (await lstat(target.path).catch(() => null)) throw workspaceError("目标已经存在", 409);
        await rename(path, target.path);
      }
      return { ok: true };
    }
    if (input.op === "download") {
      const { actual } = await locate(input);
      const handle = await open(actual, "r");
      try { const info = await handle.stat(); if (!info.isFile() || info.size > 32 * EDIT_BYTES) throw workspaceError("请通过宿主文件系统下载超过 64 MiB 的文件", 413); return { name: basename(actual), mime: mime(actual), data: (await handle.readFile()).toString("base64") }; } finally { await handle.close(); }
    }
    throw workspaceError("未知文件操作");
  }
  function subscribe(targets, notify) {
    const id = digest(`${Date.now()}:${Math.random()}`); const active = []; let timer;
    const changes = new Map();
    watches.set(id, active);
    const ready = Promise.all(targets.slice(0,64).map(async target => {
      const { actual } = await locate(target);
      if (closed || !watches.has(id)) throw workspaceError("监听已关闭", 409);
      const directory = (await stat(actual)).isDirectory();
      if (closed || !watches.has(id)) throw workspaceError("监听已关闭", 409);
      const watcher = watch(actual, (_event, name) => {
        const path = directory && name ? [target.path, String(name)].filter(Boolean).join("/") : target.path;
        if (path.split(/[\\/]/).some(part => part.toLowerCase() === ".git")) return;
        const changed = { root: target.root || "cwd", path: path.replace(/\\/g, "/") };
        changes.set(`${changed.root}:${changed.path}`, changed);
        clearTimeout(timer); timer = setTimeout(() => { notify({ type: "invalidate", targets: [...changes.values()] }); changes.clear(); }, 150);
      });
      watcher.on("error", () => notify({ type: "invalidate" })); active.push(watcher);
    })).catch(error => { unsubscribe(id); throw error; });
    active.push({ close() { clearTimeout(timer); } });
    return { id, ready };
  }
  function unsubscribe(id) { for (const watcher of watches.get(id) || []) watcher.close(); watches.delete(id); }
  const dispatch = (input) => {
    if (closed) throw workspaceError("工作区服务已关闭", 409);
    const invoke = () => request(input).catch(error => { if (error.code === "ENOENT") throw workspaceError("文件或目录已经不存在", 404); if (error.code === "EACCES" || error.code === "EPERM") throw workspaceError("文件系统拒绝访问此路径", 403); throw error; });
    if (!["save", "create", "rename", "delete"].includes(input.op)) return invoke();
    const pending = writes.then(invoke);
    writes = pending.catch(() => {});
    return pending;
  };
  return { roots, workspaceId: digest(`${hostname()}:${roots.repo || roots.cwd}`), request: dispatch, locate, subscribe, unsubscribe, close() { closed = true; for (const id of watches.keys()) unsubscribe(id); } };
}
