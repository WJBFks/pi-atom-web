import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { lstat, realpath, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_EXTERNAL_DIFF: "",
};
const TIMEOUT = 30000;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function safeOutput(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/([?&](?:token|access_token|password|key|secret)=)[^&#\s]+/gi, "$1[已隐藏]");
}

export async function createGitService(cwd) {
  let repositoryRoot = null;
  try {
    const start = await realpath(resolve(cwd));
    const rootResult = await new Promise((resolvePromise, reject) => {
      execFileCallback("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: TIMEOUT, env: ENV, windowsHide: true }, (cause, stdout, stderr) => {
        if (cause) reject(error(`无法定位 Git 仓库：${safeOutput(stderr || cause.message)}`, 500));
        else resolvePromise(stdout);
      });
    });
    repositoryRoot = await realpath(rootResult.trim());
  } catch { /* 普通目录与 Git 不可用时仍提供空状态及文件树能力 */ }
  const children = new Set();
  let closed = false;
  let queue = Promise.resolve();

  async function git(args, options = {}) {
    if (closed) throw error("Git 工作区服务已关闭", 503);
    if (!repositoryRoot) throw error("当前目录不是可用的 Git 仓库", 400);
    let child;
    try {
      const result = await new Promise((resolvePromise, reject) => {
        child = execFileCallback("git", ["-C", repositoryRoot, ...args], {
          encoding: options.encoding ?? "buffer", maxBuffer: 32 * 1024 * 1024,
          timeout: options.timeout ?? TIMEOUT,
          env: options.literalPaths === false ? { ...ENV, GIT_LITERAL_PATHSPECS: "0", GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0" } : ENV,
          windowsHide: true,
        }, (cause, stdout, stderr) => {
          const code = cause?.code;
          if (cause && !(options.acceptableExitCodes || []).includes(code)) {
            const timedOut = cause.killed || code === "ETIMEDOUT";
            reject(error(timedOut ? "Git 操作超时" : `Git 命令失败：${safeOutput(stderr?.toString?.("utf8") || cause.message || "未知错误")}`, timedOut ? 504 : 500));
          } else resolvePromise({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""), stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "") });
        });
        children.add(child);
        child.stdin?.on("error", () => {}); // Git 提前退出时由 execFile 回调报告错误。
        if (options.input !== undefined) child.stdin.end(options.input);
      });
      return options.encoding === "utf8" ? result.stdout.toString("utf8") : result.stdout;
    } catch (cause) {
      if (cause?.status) throw cause;
      throw error(`Git 执行失败：${safeOutput(cause?.message || "未知错误")}`, 500);
    } finally { if (child) children.delete(child); }
  }

  function validateName(value, label) {
    if (typeof value !== "string" || !value || value.startsWith("-") || value.includes("\0") || value.includes("\n"))
      throw error(`${label}无效`);
    return value;
  }
  async function repoPath(value, { allowMissing = false } = {}) {
    if (!repositoryRoot) throw error("当前目录不是可用的 Git 仓库", 400);
    if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value)) throw error("仓库路径无效");
    const abs = resolve(repositoryRoot, value);
    const rel = relative(repositoryRoot, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw error("不能操作仓库根目录");
    let actual = abs;
    try { actual = await realpath(abs); }
    catch (cause) {
      if (!allowMissing || cause?.code !== "ENOENT") throw error("路径不存在或无法解析");
      try {
        const entry = await lstat(abs);
        if (entry.isSymbolicLink()) throw error("不允许操作悬空符号链接");
      } catch (entryError) {
        if (entryError?.status) throw entryError;
        if (entryError?.code !== "ENOENT") throw error("路径无法解析");
      }
      let parentCandidate = dirname(abs);
      let parent;
      while (!parent) {
        try { parent = await realpath(parentCandidate); }
        catch (parentError) {
          if (parentError?.code !== "ENOENT") throw error("路径不存在或无法解析");
          const next = dirname(parentCandidate);
          if (next === parentCandidate) throw error("路径不存在或无法解析");
          parentCandidate = next;
        }
      }
      const parentRel = relative(repositoryRoot, parent);
      if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) throw error("路径目标超出仓库");
    }
    const actualRel = relative(repositoryRoot, actual);
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) throw error("路径目标超出仓库");
    const gitPathParts = (value) => value.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
    if (gitPathParts(rel).includes(".git") || gitPathParts(actualRel).includes(".git")) throw error("禁止操作 .git 元数据");
    return { abs, path: rel.split(sep).join("/") };
  }
  async function head() { return (await git(["rev-parse", "HEAD"], { encoding: "utf8" })).trim(); }
  async function status() {
    if (!repositoryRoot) return { branch: "", upstream: null, ahead: 0, behind: 0, files: [], branches: [], stashes: [], operation: null, revision: null, error: "当前目录不是可用的 Git 仓库" };
    const raw = await git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
    const fields = raw.toString("utf8").split("\0");
    const header = fields.shift() || "";
    const branchMatch = header.match(/^## (.*)$/);
    let branch = "", upstream = null, ahead = 0, behind = 0;
    const branchText = branchMatch?.[1] || "";
    const up = branchText.match(/^(.*?)\.\.\.([^ ]+)(?: \[(.*)\])?$/);
    if (up) {
      branch = up[1]; upstream = up[2];
      for (const item of (up[3] || "").split(", ")) {
        const m = item.match(/^(ahead|behind) (\d+)$/); if (m) (m[1] === "ahead" ? ahead = Number(m[2]) : behind = Number(m[2]));
      }
    } else branch = branchText.replace(/^(?:No commits yet on |Initial commit on )/, "").replace(/ \(.*\)$/, "");
    const files = [];
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i]; if (!record || record.length < 3) continue;
      const code = record.slice(0, 2); let path = record.slice(3); let originalPath;
      if (code.includes("R") || code.includes("C")) originalPath = fields[++i] || undefined;
      files.push({ path, indexStatus: code[0], worktreeStatus: code[1], ...(originalPath ? { originalPath } : {}) });
    }
    const [branchesRaw, stashesRaw, headId, operation] = await Promise.all([
      git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" }),
      git(["stash", "list", "--format=%gd%x00%gs%x00%H"], { encoding: "utf8" }).catch(() => ""),
      head().catch(() => ""),
      currentOperation(),
    ]);
    const branches = branchesRaw.split(/\r?\n/).filter(Boolean);
    const stashes = stashesRaw.split(/\r?\n/).filter(Boolean).map((line) => { const [ref, subject, id] = line.split("\0"); return { ref, subject, id }; });
    // 状态轮询不生成完整 diff；索引指纹和变更文件元数据用于写前校验。
    const indexPath = (await git(["rev-parse", "--git-path", "index"], { encoding: "utf8" })).trim();
    const index = await readFile(resolve(repositoryRoot, indexPath)).catch(cause => { if (cause.code === "ENOENT") return Buffer.alloc(0); throw cause; });
    const fingerprint = [];
    for (const item of files) {
      const p = await repoPath(item.path, { allowMissing: true }).catch(() => null);
      if (!p) { fingerprint.push(`${item.path}:missing`); continue; }
      try {
        const stat = await lstat(p.abs);
        fingerprint.push(`${item.path}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
      } catch { fingerprint.push(`${item.path}:missing`); }
    }
    const revision = createHash("sha256").update(raw).update(headId).update(index)
      .update(branchesRaw).update(stashesRaw).update(operation || "").update(fingerprint.join("\0")).digest("hex");
    return { branch, upstream, ahead, behind, files, branches, stashes, operation, revision };
  }
  async function currentOperation() {
    for (const [file, name] of [["MERGE_HEAD", "merge"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
      try { await git(["rev-parse", "--git-path", file], { encoding: "utf8" }).then(async (p) => { await lstat(resolve(repositoryRoot, p.trim())); }); return name; } catch { /* try next */ }
    }
    for (const name of ["rebase-merge", "rebase-apply"]) {
      try {
        const path = (await git(["rev-parse", "--git-path", name], { encoding: "utf8" })).trim();
        if ((await lstat(resolve(repositoryRoot, path))).isDirectory()) return "rebase";
      } catch { /* try next */ }
    }
    return null;
  }
  async function ensureRevision(expected) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw error("写操作必须提供有效 revision", 409);
    const current = await status();
    if (expected !== current.revision) throw error("工作区状态已变化，请刷新后重试", 409);
  }
  async function ignoredPaths(absolutePaths) {
    if (!repositoryRoot) return [];
    if (!Array.isArray(absolutePaths)) throw error("路径列表无效");
    if (!absolutePaths.length) return [];
    const mapped = await Promise.all(absolutePaths.map(async (value) => {
      if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw error("ignoredPaths 只接受绝对路径");
      const candidate = resolve(value);
      const rel = relative(repositoryRoot, candidate);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw error("路径必须位于仓库内");
      const repoRelative = (await repoPath(rel, { allowMissing: true })).path;
      return { absolute: value, repoRelative };
    }));
    const input = Buffer.from(`${mapped.map((item) => item.repoRelative).join("\0")}\0`);
    // check-ignore 接收路径名而不是 pathspec，不支持全局 literal magic。
    const ignored = await git(["check-ignore", "--stdin", "-z"], { input, acceptableExitCodes: [1], literalPaths: false });
    const ignoredNames = new Set(ignored.toString("utf8").split("\0").filter(Boolean));
    return mapped.filter((item) => ignoredNames.has(item.repoRelative)).map((item) => item.absolute);
  }
  async function ensureTracked(path) {
    const s = await status();
    const file = s.files.find((item) => item.path === path || item.originalPath === path);
    return { state: s, file };
  }
  async function diff({ path, kind, commit }) {
    const safe = await repoPath(path, { allowMissing: true });
    const { file } = await ensureTracked(safe.path);
    if (kind === "commit") {
      const ref = validateName(commit, "提交引用");
      const patch = await git(["show", "--format=", "--root", "--no-ext-diff", "--no-textconv", "--binary", ref, "--", safe.path], { encoding: "utf8" });
      return { patch };
    }
    if (!file && (kind === "staged" || kind === "worktree")) return { patch: "" };
    if (kind === "staged") return { patch: await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--", safe.path], { encoding: "utf8" }) };
    if (kind !== "worktree") throw error("diff kind 无效");
    if (file?.indexStatus === "?" && file?.worktreeStatus === "?") {
      const info = await lstat(safe.abs);
      if (!info.isFile() || info.isSymbolicLink()) throw error("不能读取未跟踪的非普通文件");
      if (info.size > 2 * 1024 * 1024) throw error("未跟踪文件超过 diff 读取上限");
      const bytes = await readFile(safe.abs);
      let decodedContent;
      try { decodedContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { decodedContent = null; }
      if (bytes.includes(0) || decodedContent === null) {
        const nullDevice = "/dev/null";
        const binaryPatch = await git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", nullDevice, safe.abs], { encoding: "utf8", acceptableExitCodes: [1] });
        const patch = binaryPatch.replaceAll(`a/${nullDevice}`, "/dev/null").replaceAll(`b/${safe.abs.replace(/\\/g, "/")}`, `b/${safe.path}`);
        return { patch };
      }
      const content = decodedContent;
      const hasFinalNewline = content.endsWith("\n");
      const lines = content === "" ? [] : content.replace(/\r\n/g, "\n").split("\n");
      if (hasFinalNewline) lines.pop();
      const mode = info.mode & 0o111 ? "100755" : "100644";
      const addedLines = lines.map((line, index) => `+${line}${index === lines.length - 1 && !hasFinalNewline ? "\n\\ No newline at end of file\n" : ""}`).join("\n");
      return { patch: `diff --git a/${safe.path} b/${safe.path}\nnew file mode ${mode}\nindex 0000000..0000000\n--- /dev/null\n+++ b/${safe.path}\n@@ -0,0 +1,${lines.length} @@\n${addedLines}${lines.length && hasFinalNewline ? "\n" : ""}` };
    }
    return { patch: await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--", safe.path], { encoding: "utf8" }) };
  }
  async function request(input = {}) {
    if (closed) throw error("Git 工作区服务已关闭", 503);
    const op = input.op;
    if (op === "git_status") return { ...await status() };
    if (op === "git_diff") {
      const result = await diff(input);
      const binaryOffset = result.patch.indexOf("GIT binary patch");
      if (binaryOffset >= 0) {
        result.patch = result.patch.slice(0, binaryOffset) + "二进制文件发生变化；请在文件面板预览或下载。\n";
        result.binary = true;
      }
      return { ...result, ...await status() };
    }
    if (op === "git_history") {
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
      const offset = Number(input.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw error("历史 offset 必须是非负整数");
      const args = ["log", `--max-count=${limit + 1}`, `--skip=${offset}`, "--date=iso-strict", "--format=%H%x00%s%x00%an%x00%aI"];
      if (input.cursor) args.push(validateName(input.cursor, "历史游标"));
      let history = "";
      try { history = await git(args, { encoding: "utf8" }); }
      catch (cause) { if (!(await head().catch(() => ""))) history = ""; else throw cause; }
      const rows = history.split("\n").filter(Boolean).map((row) => { const [id, subject, author, date] = row.split("\0"); return { id, subject, author, date }; });
      return { commits: rows.slice(0, limit), eof: rows.length <= limit, ...await status() };
    }
    if (op === "git_commit_files") {
      const commit = validateName(input.commit, "提交引用");
      const raw = await git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", commit]);
      const cols = raw.toString("utf8").split("\0").filter(Boolean); const files = [];
      for (let i = 0; i < cols.length;) {
        const state = cols[i++];
        if (/^[RC]/.test(state)) { const original = cols[i++]; files.push({ path: cols[i++], status: state, originalPath: original }); }
        else files.push({ path: cols[i++], status: state });
      }
      return { files, ...await status() };
    }
    if (op === "git_conflict") {
      const safe = await repoPath(input.path, { allowMissing: true }); const { file } = await ensureTracked(safe.path);
      const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
      if (!file || !conflictCodes.has(`${file.indexStatus}${file.worktreeStatus}`)) throw error("该文件当前没有冲突");
      const [ours, theirs, result] = await Promise.all([2, 3].map((stage) => git(["show", `:${stage}:${safe.path}`], { encoding: "buffer" }).catch(() => null)).concat([readFile(safe.abs).catch(() => null)]));
      const data = [ours, theirs, result]; const binary = data.some((b) => b?.includes(0));
      const versionHash = createHash("sha256");
      for (const bytes of data) {
        if (bytes === null) versionHash.update(Buffer.from([0]));
        else versionHash.update(Buffer.concat([Buffer.from([1]), Buffer.from(String(bytes.length)), Buffer.from(":"), bytes]));
      }
      const version = versionHash.digest("hex");
      const decode = (bytes) => {
        if (bytes === null) return null;
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return null; }
      };
      const decoded = data.map(decode);
      return { ours: decoded[0], theirs: decoded[1], result: decoded[2], binary: binary || data.some((bytes, index) => bytes !== null && decoded[index] === null), version, ...await status() };
    }
    if (op === "git_resolve") {
      return enqueue(async () => {
        const safe = await repoPath(input.path, { allowMissing: true }); const { file } = await ensureTracked(safe.path);
        if (!file) throw error("该文件没有冲突状态");
        const current = await request({ op: "git_conflict", path: safe.path });
        if (input.version !== current.version) throw error("冲突文件已变化，请重新读取", 409);
        if (![undefined, "ours", "theirs"].includes(input.side)) throw error("冲突解决 side 无效");
        if (input.side) {
          const stage = input.side === "ours" ? 2 : 3;
          const entries = (await git(["ls-files", "--unmerged", "-z", "--", safe.path])).toString("utf8").split("\0");
          const exists = entries.some(entry => entry.split("\t", 1)[0].endsWith(` ${stage}`));
          const raw = exists ? await git(["show", `:${stage}:${safe.path}`], { encoding: "buffer" }) : null;
          if (raw === null) {
            await unlink(safe.abs).catch((cause) => { if (cause?.code !== "ENOENT") throw cause; });
            await git(["add", "-A", "--", safe.path]);
          } else {
            await writeFile(safe.abs, raw); await git(["add", "--", safe.path]);
          }
        } else {
          if (current.binary) throw error("二进制冲突必须选择当前方或传入方");
          if (typeof input.text !== "string") throw error("解决内容无效");
          await writeFile(safe.abs, input.text, "utf8"); await git(["add", "--", safe.path]);
        }
        return { ...await status() };
      });
    }
    if (op !== "git_write") throw error("不支持的 Git 请求");
    return enqueue(async () => {
      await ensureRevision(input.revision);
      const command = input.command;
      const paths = async () => {
        if (!Array.isArray(input.paths) || !input.paths.length) throw error("请指定文件路径");
        return Promise.all(input.paths.map((p) => repoPath(p, { allowMissing: ["stage", "unstage", "discard", "delete"].includes(command) })));
      };
      if (["stage", "unstage", "discard", "delete"].includes(command)) {
        const items = await paths();
        if (command === "stage") await git(["add", "--", ...items.map((x) => x.path)]);
        if (command === "unstage") {
          if (await head().catch(() => "")) await git(["reset", "-q", "HEAD", "--", ...items.map((x) => x.path)]);
          else await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...items.map((x) => x.path)]);
        }
        if (command === "discard") {
          if (input.confirmed !== true) throw error("丢弃更改需要 confirmed=true");
          for (const item of items) {
            const st = await status(); const f = st.files.find((entry) => entry.path === item.path || entry.originalPath === item.path);
            if (!f || (f.indexStatus === "?" && f.worktreeStatus === "?")) throw error("只能通过独立文件删除操作处理未跟踪文件");
            if (f.originalPath) {
              const original = await repoPath(f.originalPath, { allowMissing: true });
              await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", original.path, f.path]);
              continue;
            }
            if (f.indexStatus === "A") {
              const hasHead = await head().then(async () => {
                const names = await git(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", item.path]);
                return names.toString("utf8").split("\0").includes(item.path);
              }).catch(() => false);
              if (!hasHead) {
                await git(["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", item.path]);
                await unlink(item.abs).catch((cause) => { if (cause?.code !== "ENOENT") throw cause; });
                continue;
              }
            }
            if (f.indexStatus !== " " && f.indexStatus !== "?") await git(["restore", "--source=HEAD", "--staged", "--", item.path]);
            await git(["restore", "--worktree", "--", item.path]).catch(async () => { if (f.worktreeStatus === "D") return; throw error("恢复工作区文件失败"); });
          }
        }
        if (command === "delete") {
          if (input.confirmed !== true) throw error("删除未跟踪文件需要 confirmed=true");
          for (const item of items) {
            const st = await status(); const f = st.files.find((entry) => entry.path === item.path);
            if (!f || f.indexStatus !== "?" || f.worktreeStatus !== "?") throw error("delete 仅接受未跟踪文件");
            const info = await lstat(item.abs).catch(() => null);
            if (!info?.isFile() || info.isSymbolicLink()) throw error("只能删除未跟踪的普通文件");
            await unlink(item.abs);
          }
        }
      } else if (command === "commit") {
        if (input.confirmed !== true) throw error("提交需要 confirmed=true");
        if (typeof input.message !== "string" || !input.message.trim() || input.message.includes("\0")) throw error("提交说明无效");
        await git(["-c", "user.useConfigOnly=true", "commit", "-m", input.message]);
      } else if (command === "branch_create") {
        await git(["branch", "--", validateName(input.branch, "分支名")]);
      } else if (command === "switch") {
        if (input.confirmed !== true) throw error("切换分支需要 confirmed=true");
        await git(["switch", validateName(input.branch, "分支名")]);
      } else if (["fetch", "pull", "push"].includes(command)) {
        if (command !== "fetch" && input.confirmed !== true) throw error(`${command} 需要 confirmed=true`);
        if (command === "fetch") await git(["fetch", "--", ...(input.remote ? [validateName(input.remote, "远程名")] : [])], { timeout: 120000 });
        if (command === "pull") {
          const strategy = input.strategy || "ff-only";
          if (!new Set(["ff-only", "merge", "rebase"]).has(strategy)) throw error("合并策略无效");
          await git(["pull", "--no-autostash", strategy === "ff-only" ? "--ff-only" : strategy === "rebase" ? "--rebase" : "--no-rebase"], { timeout: 120000 });
        }
        if (command === "push") await git(["push"], { timeout: 120000 });
      } else if (command.startsWith("stash_")) {
        const ref = input.stash === undefined ? undefined : input.stash;
        if (ref !== undefined && (typeof ref !== "string" || !/^stash@\{\d+\}$/.test(ref))) throw error("stash 仅接受 stash@{N} 引用");
        if (["stash_create", "stash_apply", "stash_pop", "stash_drop"].includes(command) && input.confirmed !== true) throw error("stash 操作需要 confirmed=true");
        if (command === "stash_create") await git(["stash", "push", ...(input.message ? ["-m", String(input.message)] : [])]);
        else if (command === "stash_apply") await git(["stash", "apply", ...(ref ? [ref] : [])]);
        else if (command === "stash_pop") await git(["stash", "pop", ...(ref ? [ref] : [])]);
        else if (command === "stash_drop") await git(["stash", "drop", ...(ref ? [ref] : [])]);
        else throw error("stash 命令无效");
      } else if (["merge_continue", "merge_abort", "rebase_continue", "rebase_abort"].includes(command)) {
        if (input.confirmed !== true) throw error("继续或中止操作需要 confirmed=true");
        if (command.endsWith("_continue") && (await status()).files.some(file => new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(`${file.indexStatus}${file.worktreeStatus}`))) throw error("仍有未解决的冲突，不能继续");
        await git(command === "merge_continue" ? ["-c", "core.editor=true", "merge", "--continue"] : command === "merge_abort" ? ["merge", "--abort"] : command === "rebase_continue" ? ["-c", "core.editor=true", "rebase", "--continue"] : ["rebase", "--abort"]);
      } else throw error("不支持的 Git 写命令");
      return { ...await status() };
    });
  }
  function enqueue(task) {
    const next = queue.then(task, task); queue = next.catch(() => {}); return next;
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const child of children) { try { child.kill(); } catch { /* process already exited */ } }
    children.clear();
  }
  return { repositoryRoot, request, ignoredPaths, close };
}
