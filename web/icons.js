import { h } from "vue";
import { packageIconEntries } from "./packages/tool-profiles.js";
const iconPaths = {
  "open-tab": '<path d="M14 3h7v7M21 3l-9 9M10 5H4v15h15v-6"/>',
  "file-plus": '<path d="M13 3H5v18h14V9l-6-6Z"/><path d="M13 3v6h6M8 15h6M11 12v6"/>',
  "folder-plus": '<path d="M3 6h7l2 2h9v12H3Z"/><path d="M9 14h6M12 11v6"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  // 自动换行：第一条整行，第二条向右后折回左边（箭头朝左）——表达「长行折回来」。
  wrap: '<path d="M4 6h16"/><path d="M4 12h11a3 3 0 0 1 0 6H8"/><path d="M11 15l-3 3 3 3"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/>',
  chat: '<path d="M4 5h16v12H8l-4 3Z"/><path d="M8 9h8M8 13h6"/>',
  trace: '<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>',
  session: '<path d="M3 6h6l2 2h10v11H3Z"/>',
  up: '<path d="M12 18V6M7 11l5-5 5 5"/>',
  down: '<path d="M12 6v12M7 13l5 5 5-5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  // 输入卡左下角的「添加」按钮：菜单展开时由 CSS 旋转 45° 变成 ×（用户 2026-09-25 选定）。
  plus: '<path d="M12 5v14M5 12h14"/>',
  mode: '<path d="M8 5h8M6 9h12M8 13h8M10 17h4"/>',
  model:
    '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M19 9h4M1 15h4M19 15h4"/>',
  thinking:
    '<path d="M9 18h6M10 22h4"/><path d="M8.5 15.5A7 7 0 1 1 15.5 15.5L14 18h-4Z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  workspace: '<path d="M3 6h7l2 2h9v11H3Z"/>',
  conversation: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tokens:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  cache:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M17.9 16A7 7 0 0 1 6 18l-2-6"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5H5v11h3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>',
  "chevron-left": '<path d="m14 6-6 6 6 6"/>',
  "chevron-right": '<path d="m10 6 6 6-6 6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 5v6h-6"/>',
  reset: '<path d="M4 13a8 8 0 1 0 2.4-5.7"/><path d="M4 7v6h6"/>',
  // 折叠块左侧的类型图标（工具各用一个独立图标）
  terminal: '<path d="M4 5h16v14H4Z"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8Z"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3Z"/>',
  diff: '<path d="M7 3v18M17 3v18"/><path d="M11 8h3M11 12h3M11 16h3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 3H4Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  box: '<path d="M3 7h18v13H3Z"/><path d="M3 7l3-4h12l3 4M9 12h6"/>',
  // 中间过程组（两张叠片 = 一组步骤的集合）：box 已被压缩块占用、trace 被「执行轨迹」页占用
  layers:
    '<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12.5 9 4.5 9-4.5"/>',
  spark: '<path d="M12 3l2.4 6.1L20 12l-5.6 2.9L12 21l-2.4-6.1L4 12l5.6-2.9Z"/>',
  "chevron-right": '<path d="m10 6 6 6-6 6"/>',
  "chevron-down": '<path d="m6 10 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  minus: '<path d="M5 12h14"/>',
  // 提问（ask_user_question 等活动组件用）
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.4a2.9 2.9 0 1 1 3.8 2.75c-.7.28-1 .85-1 1.55v.3"/><path d="M12 17.2h.01"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // 圆圈感叹号：命令的“hover 看完整命令 / 点击复制”提示
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.6v5.2"/><path d="M12 16.4h.01"/>',
};
// package 自带的图标：定义在各自适配目录里（纯数据，见 §21），通用侧只登记与渲染。
// **与内置同名时不覆盖**（通用图标优先，不让 package 清单抢掉内置图标）。
// tool-profiles.js 不带 vue 依赖，也不反向 import 本文件，所以没循环。
for (const [name, markup] of packageIconEntries())
  if (markup && !(name in iconPaths)) iconPaths[name] = markup;
export function icon(name) {
  return h("svg", {
    class: "ui-icon",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
    innerHTML: iconPaths[name] || "",
  });
}

// 思考级别仪表图标。源图已入库留档在 **docs/assets/reasoning-gauge/**（01-off … 07-max 七张 + 一张整排预览），
// 那套源图是 128×128 的仪表：7 段刻度 + 一根指针 + 轴心，点亮的那一段与指针写死 #20242A、其余 #C8CDD3。
// 页面运行时**不请求那批 SVG 文件**（也不进静态资源白名单），图标一律由下面的坐标参数化生成；
// 改了源图要同步改这里的 GAUGE_TICKS / GAUGE_LEVELS（一一对应关系写在那个目录的 README.md 里）。
// 颜色在这里改成两段：点亮段/指针/轴心用 currentColor，未点亮段是同色的 28% 透明度 —— 图标随按钮文字色走，
// 浅色/深色主题、未选中（灰）与选中（强调色）都自动适配，不必为两套主题各出一版。
// 刻度与指针坐标逐条照抄源文件（连 rotate 的中心也一样），只把 viewBox 裁到内容外框 16 31 96 61，
// 这样在 CSS 给的 19×12 槽位里刚好铺满，而不是按 128 缩成一团。
const GAUGE_TICKS = [
  [20.44, 60.75, "rotate(-65.000 25.94 64.25)"],
  [29.68, 47.95, "rotate(-43.333 35.18 51.45)"],
  [42.99, 39.47, "rotate(-21.667 48.49 42.97)"],
  [58.5, 36.5, "rotate(0.000 64.00 40.00)"],
  [74.01, 39.47, "rotate(21.667 79.51 42.97)"],
  [87.32, 47.95, "rotate(43.333 92.82 51.45)"],
  [96.56, 60.75, "rotate(65.000 102.06 64.25)"],
];
// 每个级别点亮哪一段（下标 0 起）与指针末端坐标，逐条取自源文件。
// minimal 与 minimum 是同一格（供应方两边的叫法不同）。
const GAUGE_LEVELS = {
  off: [0, 39.53, 70.59],
  minimum: [1, 45.47, 62.36],
  minimal: [1, 45.47, 62.36],
  low: [2, 54.03, 56.91],
  medium: [3, 64, 55],
  high: [4, 73.97, 56.91],
  xhigh: [5, 82.53, 62.36],
  max: [6, 88.47, 70.59],
};
const gaugeTick = (x, y, rotate, lit) =>
  '<rect class="' +
  (lit ? "gauge-lit" : "gauge-tick") +
  '" x="' +
  x +
  '" y="' +
  y +
  '" width="11" height="7" rx="3.5" transform="' +
  rotate +
  '"/>';
// 未知/自定义级别按 medium 画（指针朝正上方），至少是个像样的仪表而不是空白。
function thinkingGaugeMarkup(level) {
  const gauge = GAUGE_LEVELS[level] || GAUGE_LEVELS.medium;
  let markup = "";
  for (let i = 0; i < GAUGE_TICKS.length; i += 1)
    markup += gaugeTick(GAUGE_TICKS[i][0], GAUGE_TICKS[i][1], GAUGE_TICKS[i][2], i === gauge[0]);
  return (
    markup +
    '<line class="gauge-needle" x1="64" y1="82" x2="' +
    gauge[1] +
    '" y2="' +
    gauge[2] +
    '"/><circle class="gauge-hub" cx="64" cy="82" r="7.5"/>'
  );
}
// 七个级别的仪表图是常量，按级别缓存 vnode，避免每次重开弹层重拼一遍字符串。
const thinkingGaugeCache = new Map();
/** 思考级别仪表图标（尺寸由 style.css 的 .gauge-icon 给）。@param {string} level @returns {any} */
export function thinkingIcon(level) {
  const key = String(level || "");
  if (!thinkingGaugeCache.has(key))
    thinkingGaugeCache.set(
      key,
      h("svg", {
        class: "ui-icon gauge-icon",
        viewBox: "16 31 96 61",
        "aria-hidden": "true",
        innerHTML: thinkingGaugeMarkup(key),
      }),
    );
  return thinkingGaugeCache.get(key);
}
