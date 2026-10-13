const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function codeBlock(value, language = "", { highlight = true, startLine = 1 } = {}) {
  const source = String(value ?? "");
  const first =
    Number.isFinite(Number(startLine)) && Number(startLine) > 0
      ? Math.floor(Number(startLine))
      : 1;
  const requested = String(language || "")
    .trim()
    .split(/\s+/, 1)[0]
    .toLowerCase();
  let detected = requested || "text",
    rendered = escapeHtml(source);
  if (highlight && globalThis.hljs) {
    const known = requested && globalThis.hljs.getLanguage(requested);
    const result = known
      ? globalThis.hljs.highlight(source, {
          language: requested,
          ignoreIllegals: true,
        })
      : globalThis.hljs.highlightAuto(source);
    detected = known ? requested : result.language || "text";
    rendered = result.value;
  }
  const lineCount = Math.max(1, source.split("\n").length);
  const lines = Array.from(
    { length: lineCount },
    (_, index) => index + first,
  ).join(
    "\n",
  );
  const copyButton = `<button type="button" class="code-copy" aria-label="复制" title="复制"><span class="icon-copy"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5H5v11h3"/></svg></span><span class="icon-done"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></span></button>`;
  // 自动换行开关（用户 2026-10-01：所有代码块都要有，与侧栏文件视图共用一个全局状态）。
  // 代码块是字符串模板、各处用 innerHTML 注入，拿不到组件内的事件绑定，所以点击由 `web/line-wrap.js`
  // 的**文档级委托**接住；`aria-pressed` 也山它每次刷完行号后统一写（写死初值会与全局状态不一致）。
  const wrapButton = `<button type="button" class="code-wrap-toggle" aria-label="自动换行" title="自动换行" aria-pressed="false"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h11a3 3 0 0 1 0 6H8"/><path d="M11 15l-3 3 3 3"/></svg></button>`;
  return `<div class="code-block"><div class="code-header"><span>${escapeHtml(detected)}</span><span>${lineCount} 行</span>${wrapButton}${copyButton}</div><div class="code-scroll"><pre class="code-lines" aria-hidden="true">${lines}</pre><pre class="code-source"><code class="hljs language-${escapeHtml(detected)}">${rendered}</code></pre></div></div>`;
}

export function unclosedFence(raw) {
  const source = String(raw || "");
  const opener = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source);
  if (!opener) return false;
  const marker = opener[1][0],
    minimum = opener[1].length;
  const rest = source.slice(opener[0].length);
  const closing = new RegExp(
    `(?:^|\\n) {0,3}${marker}{${minimum},}[ \\t]*(?:\\n|$)`,
  );
  return !closing.test(rest);
}

export function configureMarkdown() {
  if (globalThis.marked) globalThis.marked.__atomWebConfigured = true;
}

export function renderMarkdown(text, { live = false, breaks = false } = {}) {
  if (!globalThis.marked || !globalThis.DOMPurify) return "";
  const renderer =
    typeof globalThis.marked.Renderer === "function"
      ? new globalThis.marked.Renderer()
      : {};
  renderer.code = (token) =>
    codeBlock(token.text, token.lang, {
      highlight: !(live && unclosedFence(token.raw)),
    });
  const html = globalThis.marked.parse(String(text || ""), { renderer, breaks });
  return globalThis.DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "style", "input", "form"],
    FORBID_ATTR: ["style"],
  });
}

/**
 * 单行标题用的 **inline** Markdown（活动组件 tab 标题等一行高的槽位）。
 *
 * 与 `renderMarkdown` 的区别：
 * - 走 `parseInline`，只出行内标记（`` `code` ``、`**粗体**`、`*斜体*`、`~~删除线~~`），
 *   永远不会产生 `<p>`/`<ul>`/`<pre>` 这类块级盒子（否则会把 tab 顶变形）；
 * - 白名单比正文更严：只放行行内标签，且**属性全清**。
 *   链接也去成纯文本：tab 自身是可点击元素，不能套嵌套交互。
 *
 * marked / DOMPurify 由 `server.ts` 以 `<script defer>` 提供，理论上早于模块代码执行；
 * 真拿不到时退回转义后的原文（宁可看到反引号，也不能渲染空白标题或原始 HTML）。
 */
const INLINE_MARKDOWN_TAGS = [
  "code",
  "em",
  "strong",
  "del",
  "ins",
  "samp",
  "kbd",
  "mark",
  "small",
  "sub",
  "sup",
  "q",
  "abbr",
  "b",
  "i",
  "br",
  "span",
];

export function renderInlineMarkdown(text) {
  const source = String(text ?? "");
  if (!globalThis.marked || !globalThis.DOMPurify) return escapeHtml(source);
  let html = "";
  try {
    html = globalThis.marked.parseInline(source, { breaks: false, gfm: true });
  } catch {
    return escapeHtml(source);
  }
  return globalThis.DOMPurify.sanitize(html, {
    ALLOWED_TAGS: INLINE_MARKDOWN_TAGS,
    ALLOWED_ATTR: [],
  });
}

/**
 * 把 inline Markdown 摘成纯文本：给 `title` 浮层、阻塞提示行这类不能渲染 HTML 的位置用。
 * （否则浮层里会看到 `消息队列 \`3\`` 这种带反引号的源码。）
 * 只处理常见的几种标记；`*` / `_` 只在**词边界**上摘，否则包名这类
 * `ask_user_question` 会被剔成 `askuser_question`。
 */
export function stripInlineMarkdown(text) {
  return String(text ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[\s(（])[*_]([^*_]+?)[*_](?=$|[\s)）.,;:!!?])/g, "$1$2")
    .trim();
}

