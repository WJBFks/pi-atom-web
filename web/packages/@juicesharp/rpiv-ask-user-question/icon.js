/**
 * 提问的专属图标（package 专属，用户 2026-09-26：“单独为提问准备一个图标”）。
 *
 * **纯数据、不 `import` 任何东西**：本文件由 `tool-profile.js` 带进 `tool-profiles.js`，
 * 而那条链在 `turnGroups.js` 与 `icons.js` 的依赖上（Node 侧用例也走它），所以不能在这里
 * `import` 依赖 vue 的 `web/icons.js`。登记与渲染都由通用侧负责。
 *
 * 形状：外框沿用通用 `chat` 的气泡轮廓（同一族），里面换成问号。刻意与两个既有图标区分：
 * `chat`（气泡 + 两条文字，= 普通对话）与 `help`（圆圈问号，现在只留给「关于」页与通用请求）。
 * 问号用 `help` 同一套 `arc + 竖段 + 点` 构造缩到 0.8 倍放进气泡内部（弧的弦长 3.58 ≤ 2r=4.4，
 * 所以画得出来；气泡内部是 y 5..17，问号落在 y 7.4..15.4，视觉中心略高于内部几何中心，
 * 因为下方是气泡尖角，压一点才不显头重脚轻）。
 *
 * **不写 `stroke`/`fill`**：描边一律由图标基座 `.ui-icon` 给（`fill:none;stroke:currentColor;
 * stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round`，style.css），因此这个图标
 * 自动跟随工具卡的状态色（正常灰、报错红，见 §12），不必为深色主题另出一版。
 */
export const ASK_ICON_NAME = "ask-question";

export const ASK_ICON_MARKUP =
  '<path d="M4 5h16v12H8l-4 3Z"/>' +
  '<path d="M10 9.6a2.2 2.2 0 1 1 2.9 2.1c-.6.24-.9.73-.9 1.3v.2"/>' +
  '<path d="M12 15.4h.02"/>';
