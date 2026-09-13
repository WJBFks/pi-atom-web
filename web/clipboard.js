export async function writeClipboard(text) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    /* local fallback */
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
