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
  return `<div class="code-block"><div class="code-header"><span>${escapeHtml(detected)}</span><span>${lineCount} 行</span>${copyButton}</div><div class="code-scroll"><pre class="code-lines" aria-hidden="true">${lines}</pre><pre class="code-source"><code class="hljs language-${escapeHtml(detected)}">${rendered}</code></pre></div></div>`;
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
