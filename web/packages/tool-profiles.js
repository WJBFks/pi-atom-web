/**
 * package 的「工具档案」：某个第三方 package 注册的工具，在**会话转录**里该怎么显示。
 *
 * 为什么要有这张表（用户 2026-09-26）：package 专属的信息不得写进通用组件 ——
 * `ToolCallBlock.js` / `turnGroups.js` 只查 `toolProfile()`，出现不了任何 package 的工具名；
 * 字面量只写在 `web/packages/<package>/tool-profile.js` 里。
 *
 * 与同目录 `registry.js` 的区别：那张表登记的是**组件与 CSS**，按 §21 必须等带 `packageId`
 * 的请求到达后才惰性导入；这里登记的是**纯数据清单**（几个字符串）。工具卡与分组必须在
 * 任何请求到达之前就正确（历史会话里的旧卡片也要正确），所以清单在模块加载时静态登记，
 * 未安装该 package 时这些条目只是永不命中，无副作用、不报错。
 *
 * 字段：
 * - `tool`：工具名（小写比较）；
 * - `label`：卡片标题里显示的名字，缺省用工具原名；
 * - `solo`：`true` = 它的工具卡**不折进中间过程组**，单独平铺在组之间（轮次标题仍把它
 *   算进「工具调用」——计数走整段，与在不在组里无关；见 §9）。
 * - `summary(args)`：可选，**折叠态摘要**（`.disclosure-preview`）。返回空串 = 交给
 *   通用摘要（工具输出 / 报错信息）。
 * - `icon`：可选，`{ name, markup }`。`name` 是卡片左侧类型图标的图标名，`markup` 是它的
 *   SVG 内容（纯字符串，包目录里不能 `import` 依赖 vue 的 `icons.js`）。由 `web/icons.js`
 *   在模块求值时登记进图标表，**与内置同名时不覆盖**。
 */

/** @type {Map<string, {tool: string, label?: string, solo?: boolean, summary?: Function, icon?: {name: string, markup: string}}>} */
const profiles = new Map();

export function registerToolProfile(profile) {
  const tool = String(profile?.tool || "").toLowerCase();
  if (!tool) return () => {};
  profiles.set(tool, { ...profile, tool });
  return () => profiles.delete(tool);
}

export function toolProfile(name) {
  return profiles.get(String(name || "").toLowerCase()) ?? null;
}

/** 卡片标题用名：package 档案优先，其次 pi 自带工具的本地化，最后工具原名。 */
export function toolProfileLabel(name) {
  return toolProfile(name)?.label || null;
}

/** 该工具的结果条是否与卡片一起平铺（`solo` 的工具卡片已按 toolCallId 合并了结果条）。 */
export function isSoloTool(name) {
  return Boolean(toolProfile(name)?.solo);
}

/** 卡片左侧类型图标用名（档案 `icon.name`）；没登记时返回空串，由调用方退回通用图标表。 */
export function toolIconName(name) {
  return toolProfile(name)?.icon?.name || "";
}

/**
 * 档案自定义的折叠态摘要。返回空串 = 通用摘要（工具输出 / 报错信息）。
 * package 侧的代码不能让它把卡片抽掉，所以异常一律吞掉退回通用摘要。
 */
export function toolProfileSummary(name, args) {
  const custom = toolProfile(name)?.summary;
  if (typeof custom !== "function") return "";
  try {
    return String(custom(args) ?? "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * 档案自带的图标（`icon: { name, markup }`），给 `web/icons.js` 在模块求值时登记。
 * 只在**模块加载期**登记的图标生效（本文件的清单正是加载期静态登记的）。
 */
export function packageIconEntries() {
  const entries = [];
  for (const profile of profiles.values())
    if (profile?.icon?.name && profile?.icon?.markup)
      entries.push([profile.icon.name, profile.icon.markup]);
  return entries;
}

// —— package 清单（数据，不含组件与 CSS）——
import askUserQuestionProfile from "./@juicesharp/rpiv-ask-user-question/tool-profile.js";

registerToolProfile(askUserQuestionProfile);
