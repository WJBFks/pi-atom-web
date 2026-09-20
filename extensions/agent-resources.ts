// Agent 定义（Agent Definition）：pi 启动时自动装配的一组声明式输入。
// 本模块只读，产出 snapshot 的 agentResources 字段，供设置页
// 「技能 / 扩展 / 模板 / 定义」四个分类展示：
// - 技能、模板取自 pi.getCommands()（正式 API，真实加载清单，含
//   npm 包与扩展 resources_discover 动态上报的资源）；
// - 扩展列表运行时不对外暴露，这里按 pi 的目录发现规则镜像扫描磁盘
//   （全局/项目/两级 settings.json/npm pi-packages）；
// - 定义（上下文文件、SYSTEM/APPEND_SYSTEM、settings、packages、信任状态）
//   按 pi 的加载规则从磁盘推导。
// 项目未受信时 pi 不加载项目级资源，此处同步不列出（与真实加载一致）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import os from "node:os";

export interface ResourceEntry {
  name: string;
  description?: string;
  path: string;
  /** 来源：global = ~/.pi/agent，project = 项目 .pi/，package = npm pi-package */
  source: "global" | "project" | "package";
  /** 包名（source="package" 时） */
  sourceName?: string;
}

export interface AgentResourcesDefinition {
  /** pi 实际会加载的上下文文件（全局 → 顶层父目录 → 当前目录） */
  contextFiles: { path: string; size: number }[];
  /** 替换系统提示的 SYSTEM.md（项目优先于全局）；null = 未自定义 */
  systemPromptFile: string | null;
  /** 追加系统提示的 APPEND_SYSTEM.md（项目优先于全局）；null = 无追加 */
  appendSystemPromptFile: string | null;
  settings: { path: string; exists: boolean }[];
  /** 两级 settings.json 的 packages 声明（全局在前） */
  packages: string[];
  projectTrusted: boolean;
}

export interface AgentResources {
  skills: ResourceEntry[];
  extensions: ResourceEntry[];
  prompts: ResourceEntry[];
  definition: AgentResourcesDefinition;
}

// 与 pi resource-loader 的候选列表一致（含大小写变体，override 优先）。
const CONTEXT_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function readJson(p: string): any | null {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function firstExisting(files: string[]): string | null {
  for (const f of files) if (isFile(f)) return f;
  return null;
}

/**
 * 镜像 pi resource-loader 的上下文文件发现：
 * 全局 agent 目录一个，然后从 cwd 逐层向上（顶层父目录 → 当前目录），
 * 同一目录按 AGENTS.override.md > AGENTS.md > CLAUDE.md 取第一个。
 * （git worktree 影子文件等边界情况从略：只影响极特殊的嵌套 worktree。）
 */
export function findContextFiles(cwd: string, agentDirPath: string): { path: string; size: number }[] {
  const seen = new Set<string>();
  const pick = (dir: string): string | null => {
    for (const name of CONTEXT_CANDIDATES) {
      const p = join(dir, name);
      if (isFile(p) && !seen.has(p)) {
        seen.add(p);
        return p;
      }
    }
    return null;
  };
  const files: string[] = [];
  const globalFile = pick(agentDirPath);
  if (globalFile) files.push(globalFile);
  const ancestorFiles: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const f = pick(dir);
    if (f) ancestorFiles.unshift(f);
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  files.push(...ancestorFiles);
  return files.map((p) => ({ path: p, size: statSync(p).size }));
}

/**
 * 镜像 pi 的扩展目录发现（package-manager collectAutoExtensionEntries）：
 * 目录自身先查 package.json 的 pi manifest extensions / index.ts / index.js，
 * 否则展开顶层 .ts/.js 文件与带 index 的子目录。
 * （settings/manifest 里的 glob 模式从略：按字面路径解析，不命中就不列出。）
 */
function resolveExtensionEntries(dir: string): string[] | null {
  const pkgJsonPath = join(dir, "package.json");
  if (isFile(pkgJsonPath)) {
    const list = readJson(pkgJsonPath)?.pi?.extensions;
    if (Array.isArray(list)) {
      const entries = list
        .filter((e): e is string => typeof e === "string")
        .map((e) => resolve(dir, e))
        .filter((p) => existsSync(p));
      if (entries.length) return entries;
    }
  }
  for (const name of ["index.ts", "index.js"]) {
    const p = join(dir, name);
    if (isFile(p)) return [p];
  }
  return null;
}

function scanExtensionDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const rootEntries = resolveExtensionEntries(dir);
  if (rootEntries) return rootEntries;
  const entries: string[] = [];
  let items: any[] = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return entries; }
  for (const item of items) {
    if (!item.name || item.name.startsWith(".") || item.name === "node_modules") continue;
    const full = join(dir, item.name);
    let isDir = item.isDirectory();
    let isFile = item.isFile();
    if (item.isSymbolicLink()) {
      try {
        const s = statSync(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch { continue; }
    }
    if (isFile && (item.name.endsWith(".ts") || item.name.endsWith(".js"))) {
      entries.push(full);
    } else if (isDir) {
      const sub = resolveExtensionEntries(full);
      if (sub) entries.push(...sub);
    }
  }
  return entries;
}

function extensionName(p: string): string {
  const base = basename(p);
  if (base === "index.ts" || base === "index.js") return basename(resolve(p, ".."));
  return base.replace(/\.(ts|js)$/, "");
}

/** "npm:@scope/name@1.2.3" → "@scope/name"；"npm:foo" → "foo"；非 npm 源 → null */
function parseNpmName(entry: string): string | null {
  if (!entry.startsWith("npm:")) return null;
  let spec = entry.slice(4);
  const at = spec.lastIndexOf("@");
  if (at > 0) spec = spec.slice(0, at);
  return spec || null;
}

/**
 * 组装 agentResources 快照字段（只读、幂等，可重复调用）。
 * @param opts.cwd 当前工作目录
 * @param opts.isProjectTrusted 项目信任状态；未受信时不列出项目级资源
 * @param opts.getCommands pi.getCommands()（正式 API）
 * @param opts.agentDir 可注入（测试用），默认 ~/.pi/agent
 */
export function buildAgentResources(opts: {
  cwd: string;
  isProjectTrusted: boolean;
  getCommands: () => Array<{
    name?: string;
    description?: string;
    source?: string;
    sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string };
  }>;
  agentDir?: string;
}): AgentResources {
  const cwd = resolve(opts.cwd);
  const agentDirPath = opts.agentDir ?? join(os.homedir(), ".pi", "agent");
  const trusted = opts.isProjectTrusted;

  // --- 技能 / 模板：真实加载清单（含包与扩展动态上报） ---
  let commands: any[] = [];
  try { commands = opts.getCommands() || []; } catch { commands = []; }
  const toEntry = (command: any, stripPrefix: string): ResourceEntry | null => {
    const raw = typeof command.name === "string" ? command.name : "";
    const name = stripPrefix ? raw.slice(stripPrefix.length) : raw;
    if (!name) return null;
    const info = command.sourceInfo;
    let source: ResourceEntry["source"] = "global";
    let sourceName: string | undefined;
    if (info?.origin === "package") {
      source = "package";
      sourceName = typeof info.source === "string" && info.source ? info.source : "package";
    } else if (info?.scope === "project") {
      source = "project";
    }
    const entry: ResourceEntry = { name, path: typeof info?.path === "string" ? info.path : "", source };
    if (typeof command.description === "string" && command.description) entry.description = command.description;
    if (sourceName) entry.sourceName = sourceName;
    return entry;
  };
  const skills: ResourceEntry[] = [];
  const prompts: ResourceEntry[] = [];
  for (const command of commands) {
    if (command?.source === "skill") {
      const entry = toEntry(command, "skill:");
      if (entry) skills.push(entry);
    } else if (command?.source === "prompt") {
      const entry = toEntry(command, "");
      if (entry) prompts.push(entry);
    }
  }
  const byName = (a: ResourceEntry, b: ResourceEntry) => a.name.localeCompare(b.name);
  skills.sort(byName);
  prompts.sort(byName);

  // --- 扩展：按 pi 的目录发现规则镜像扫描 ---
  const extensions: ResourceEntry[] = [];
  const addExt = (path: string, source: ResourceEntry["source"], sourceName?: string) => {
    if (!path || extensions.some((item) => item.path === path)) return;
    const entry: ResourceEntry = {
      // 包提供的扩展以包名展示，同包多个文件时更易读。
      name: source === "package" && sourceName ? sourceName : extensionName(path),
      path,
      source,
    };
    if (sourceName) entry.sourceName = sourceName;
    extensions.push(entry);
  };

  for (const p of scanExtensionDir(join(agentDirPath, "extensions"))) addExt(p, "global");

  // 全局 settings.json 声明的扩展不受项目信任限制
  const addSettingEntries = (settingsDir: string, source: ResourceEntry["source"]) => {
    const list = readJson(join(settingsDir, "settings.json"))?.extensions;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== "string" || !item || item.startsWith("!")) continue;
      const expanded = item.startsWith("~")
        ? join(os.homedir(), item.slice(1))
        : resolve(settingsDir, item);
      if (isFile(expanded)) addExt(expanded, source);
      else if (existsSync(expanded)) for (const p of scanExtensionDir(expanded)) addExt(p, source);
    }
  };
  addSettingEntries(agentDirPath, "global");

  if (trusted) {
    for (const p of scanExtensionDir(join(cwd, ".pi", "extensions"))) addExt(p, "project");
    // 项目 settings.json 的 extensions 显式路径声明
    addSettingEntries(join(cwd, ".pi"), "project");
  }

  // npm pi-packages：读两级 settings.json 的 packages 声明并展开其携带的扩展
  const packages: string[] = [];
  const addPackages = (settingsDir: string, npmRoot: string) => {
    const list = readJson(join(settingsDir, "settings.json"))?.packages;
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim() || entry.startsWith("!")) continue;
      if (packages.includes(entry)) continue;
      packages.push(entry);
      const pkgName = parseNpmName(entry);
      if (!pkgName) continue;
      const pkgDir = join(npmRoot, pkgName);
      const pkg = readJson(join(pkgDir, "package.json"));
      const manifestList = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : null;
      if (manifestList?.length) {
        for (const e of manifestList) {
          if (typeof e === "string" && existsSync(resolve(pkgDir, e))) addExt(resolve(pkgDir, e), "package", pkgName);
        }
      } else {
        const extDir = join(pkgDir, "extensions");
        if (existsSync(extDir)) for (const p of scanExtensionDir(extDir)) addExt(p, "package", pkgName);
      }
    }
  };
  addPackages(agentDirPath, join(agentDirPath, "npm", "node_modules"));
  if (trusted) addPackages(join(cwd, ".pi"), join(cwd, ".pi", "npm", "node_modules"));

  const bySourceName = (a: ResourceEntry, b: ResourceEntry) => {
    if (a.source !== b.source) {
      const rank = { global: 0, project: 1, package: 2 } as const;
      return rank[a.source] - rank[b.source];
    }
    return a.name.localeCompare(b.name);
  };
  extensions.sort(bySourceName);

  // --- 定义：系统提示文件 / 设置 / packages / 信任状态 ---
  const definition: AgentResourcesDefinition = {
    contextFiles: findContextFiles(cwd, agentDirPath),
    systemPromptFile: firstExisting([join(cwd, ".pi", "SYSTEM.md"), join(agentDirPath, "SYSTEM.md")]),
    appendSystemPromptFile: firstExisting([join(cwd, ".pi", "APPEND_SYSTEM.md"), join(agentDirPath, "APPEND_SYSTEM.md")]),
    settings: [
      { path: join(agentDirPath, "settings.json"), exists: isFile(join(agentDirPath, "settings.json")) },
      { path: join(cwd, ".pi", "settings.json"), exists: isFile(join(cwd, ".pi", "settings.json")) },
    ],
    packages,
    projectTrusted: trusted,
  };

  return { skills, extensions, prompts, definition };
}
