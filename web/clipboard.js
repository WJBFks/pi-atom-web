/**
 * 把文本写入剪贴板。
 *
 * 两条路径，顺序与理由：
 * 1. 安全上下文（https / localhost）优先 `navigator.clipboard.writeText`；
 *    用 800ms 超时兜底 —— Windows 上剪贴板被其它应用锁住时该 Promise 可能永远
 *    挂起（不 reject 也不 resolve），不加超时就没有第二次机会。
 * 2. 同步 `execCommand("copy")` 兜底（非安全上下文如局域网 IP 访问时
 *    `navigator.clipboard` 根本不存在）。注意它依赖点击的「临时用户激活」，
 *    所以超时窗口必须短，且兜底前不能有多余的异步跳变。
 */
export async function writeClipboard(text) {
  const value = String(text ?? "");
  const modern =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";
  if (modern) {
    let wrote = false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(value).then(() => {
          wrote = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
      if (wrote) return;
      /* 超时未写成功：落入下方同步兜底 */
    } catch {
      /* 落入下方同步兜底 */
    }
  }
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  Object.assign(input.style, {
    position: "fixed",
    opacity: "0",
    top: "0",
    left: "0",
  });
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请手动复制");
  } finally {
    input.remove();
    focused?.focus?.({ preventScroll: true });
  }
}
