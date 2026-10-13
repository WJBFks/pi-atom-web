import { ref, watch } from "vue";

/**
 * 全站共用的「自动换行」开关 + 行号逐行对齐。用户 2026-10-01 先给侧栏文件编辑器加了换行按钮，
 * 紧接着要求**所有代码块**都加上、共享同一个开关状态 —— 于是开关、测高、行号改造都收在这里，
 * `web/main.js` 调一次 `installLineWrap()`。
 *
 * 覆盖两类宿主（`WRAP_HOSTS`）：
 * - 侧栏文件编辑器 `.ws-code`：`<textarea>` + `.ws-lines`
 * - `codeBlock()` 的产物 `.code-block`（工具卡输入输出、Markdown 输出、自定义 Entry、侧栏文件预览）：
 *   `pre.code-source` + `pre.code-lines`
 *
 * 折行本身是纯 CSS（`style.css` 里 `html.atom-wrap …` 那组规则），开关状态同步到 `<html class="atom-wrap">`，
 * 切换时不需要重渲染任何组件。必须靠 JS 的只有**行号对齐**：两边行号原先都是「所有数字 `join("\n")`
 * 拼成一整块文本」，高度只按逻辑行数算；正文一折行，一个逻辑行占多个视觉行，数字就整列往上挤。
 * 所以这里把行号列改成「一格一行」，每格高度写该行折行后的真实高度。
 *
 * 为什么要监听 DOM：`codeBlock()` 返回的是 HTML 字符串，各处用 `innerHTML` 注入，拿不到组件内的
 * 事件绑定与生命周期，按钮只能靠文档级委托，行号只能在 DOM 变动后补。
 */
const KEY = "atom-line-wrap";
/** 需要逐行对齐的宿主；`bar` 取正文元素，`cells` 取行号列。 */
const WRAP_HOSTS = ".ws-code, .code-block";

function initial() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

/** 全站唯一的换行开关，默认关（长行仍旧横向滚动）。 */
export const wrapLines = ref(initial());

watch(wrapLines, (value) => {
  try {
    if (value) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
  document.documentElement?.classList.toggle("atom-wrap", Boolean(value));
  schedule();
});

/* ---------- 隐藏镜像测高 ---------- */

let mirror;
const px = (value) => parseFloat(value) || 0;

/**
 * 镜像是一列隐藏 `<div>`，逐行放同一句**纯文本**；字体、行高、字距、`tab-size`、折行规则与宽度
 * 全从正文元素的 `getComputedStyle` 照抄。宽度取 `clientWidth - 左右 padding`：textarea 的
 * `clientWidth` 已扣掉纵向滚动条，那正好是它的折行宽度。
 *
 * 纯文本能代表带高亮的正文，是因为本项目等宽字体下只有 `.hljs-comment`/`.hljs-quote` 是 italic，
 * 斜体不换字符宽度。**以后若给高亮加 `font-weight:bold` 且字体没有同宽粗体，这里的测量会偏。**
 */
function mirrorElement() {
  if (!mirror?.isConnected) {
    mirror = document.createElement("div");
    mirror.className = "line-wrap-measure";
    mirror.setAttribute("aria-hidden", "true");
    document.body?.appendChild(mirror);
  }
  return mirror;
}

/**
 * 行号列改成一格一行，并逐格写入折行后的真实高度。
 * @param {object} options
 * @param {HTMLElement} options.bar    正文元素（`<textarea>` 或 `pre.code-source`）
 * @param {HTMLElement} options.cells  行号列（`.ws-lines` / `pre.code-lines`）
 * @param {string[]} options.texts     每个逻辑行的文本
 * @param {number} [options.startLine] 起始行号（分页预览从第 N 行开始）
 * @returns {boolean} 是否量到了：折叠块收起、侧栏隐藏时量不到，返回 false，等下次变动再量
 */
export function alignRowGutter({ bar, cells, texts, startLine = 1 }) {
  if (!bar?.isConnected || !cells || !bar.clientWidth) return false;
  if (cells.childElementCount !== texts.length) {
    cells.textContent = "";
    const rows = document.createDocumentFragment();
    for (let index = 0; index < texts.length; index += 1) {
      const row = document.createElement("div");
      row.textContent = String(startLine + index);
      rows.appendChild(row);
    }
    cells.appendChild(rows);
  }
  const style = getComputedStyle(bar), target = mirrorElement().style;
  target.font = style.font;
  target.lineHeight = style.lineHeight;
  target.letterSpacing = style.letterSpacing;
  target.tabSize = style.tabSize || "8";
  const fallback = px(style.lineHeight) || 18;
  target.width = `${Math.max(24, bar.clientWidth - px(style.paddingLeft) - px(style.paddingRight))}px`;
  mirror.textContent = "";
  const lines = document.createDocumentFragment();
  for (const text of texts) {
    const row = document.createElement("div");
    row.textContent = text.length ? text : " "; // 空行也得占一行高
    lines.appendChild(row);
  }
  mirror.appendChild(lines);
  // 先读齐再写：读 offsetHeight 会强制重排，跟写高度交替进行就是 N 次布局。
  const heights = Array.from(mirror.children, (cell) => cell.offsetHeight);
  for (let index = 0; index < cells.children.length; index += 1) {
    const height = `${heights[index] || fallback}px`;
    if (cells.children[index].style.height !== height) cells.children[index].style.height = height;
  }
  return true;
}

/** 关掉换行：行号列还原成「所有数字拼成一整块文本」，顺带抹掉逐格高度。 */
export function resetRowGutter(cells, count, startLine = 1) {
  if (!cells) return;
  const text = Array.from({ length: Math.max(1, count) }, (_, index) => startLine + index).join("\n");
  if (cells.childElementCount || cells.textContent !== text) cells.textContent = text;
}

/* ---------- 宿主扫描 ---------- */

const signatures = new WeakMap();

/** 起始行号：编辑器写在 `data-start-line` 上；代码块从它自己那份行号文本里读第一个数。 */
function startLineOf(host, cells) {
  const declared = Number(host.dataset.startLine);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const stored = Number(cells.dataset.wrapStart);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const first = Number(/^\s*(\d+)/.exec(cells.textContent)?.[1]);
  const start = Number.isFinite(first) && first > 0 ? first : 1;
  cells.dataset.wrapStart = String(start);
  return start;
}

function syncHost(host) {
  const bar = host.querySelector("textarea") || host.querySelector(".code-source");
  const cells = host.querySelector(".ws-lines") || host.querySelector(".code-lines");
  if (!bar || !cells) return;
  const raw = String(bar.value ?? bar.textContent ?? "");
  if (!wrapLines.value) {
    // 关闭态只做两件事：把换行期留下的逐格还原，以及填编辑器刚渲染时的空行号列。
    if (cells.childElementCount || !cells.textContent) resetRowGutter(cells, raw.split("\n").length, startLineOf(host, cells));
    signatures.delete(host);
    return;
  }
  // 只用「文本长度 + 正文宽度」当签名：流式输出时每帧都 split 整段文本太浪费，长度变了必然行数也看过。
  const signature = `${raw.length}:${bar.clientWidth}`;
  if (signatures.get(host) === signature) return;
  if (alignRowGutter({ bar, cells, texts: raw.split("\n"), startLine: startLineOf(host, cells) })) {
    signatures.set(host, signature);
    observe(bar); // 宿主宽度变化（拖侧栏、改窗口）后逐格高度必须重算
  }
}

let observer, watched = new WeakSet(), mutations, queued = false, installed = false;

function observe(bar) {
  if (watched.has(bar) || !bar.isConnected) return;
  if (!observer) observer = new ResizeObserver((entries) => {
    for (const entry of entries) signatures.delete(entry.target.closest?.(WRAP_HOSTS) || entry.target);
    schedule();
  });
  watched.add(bar);
  observer.observe(bar);
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const host of document.querySelectorAll(WRAP_HOSTS)) syncHost(host);
    // 代码块头部那颗按钮的 aria-pressed 是字符串模板里的静态值，状态变了统一刷一遍。
    for (const button of document.querySelectorAll(".code-wrap-toggle"))
      button.setAttribute("aria-pressed", wrapLines.value ? "true" : "false");
  });
}

/** 组件在正文 / 模式 / 分页起点变了以后催一次（textarea 的 value 变动不产生 DOM 变动记录）。 */
export function refreshLineWrap() {
  schedule();
}

/**
 * 装一次：刷初值、接住代码块头部的换行按钮、盯住 DOM 变动。
 * 流式输出追加、折叠块展开、切工具卡都会新增或改写代码块，所以不能只在挂载时扫一遍。
 * @param {Document|HTMLElement} [root] 事件委托的挂载点
 */
export function installLineWrap(root = document) {
  document.documentElement?.classList.toggle("atom-wrap", wrapLines.value);
  root.addEventListener("click", (event) => {
    if (!event.target?.closest?.(".code-wrap-toggle")) return;
    wrapLines.value = !wrapLines.value;
    event.preventDefault();
  });
  if (installed || !document.body) return void schedule();
  installed = true;
  mutations = new MutationObserver(() => schedule());
  mutations.observe(document.body, { childList: true, subtree: true });
  schedule();
}
