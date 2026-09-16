/**
 * 中止产生的固定措辞判定。
 *
 * 至少有两套来源，措辞不同：
 *   · Pi 宿主：`Operation aborted`（工具结果 / assistant.errorMessage）
 *   · Node 的 AbortError：`This operation was aborted`（fetch、子进程等被 abort 时）
 *
 * 这类情况已由红色的「已中断（：原因）」状态提示（横线）表达，
 * 所以消息正文与工具卡里都不再单独重复显示这段文本。
 *
 * 刻意用**整段精确匹配**（允许首尾空白、句末标点）而不是「包含 aborted」——
 * 否则正常输出里出现 aborted 字样（例如 `grep aborted`、日志正文）会被误吞。
 */
export function isAbortNotice(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return /^(?:(?:this|the) )?(?:operation(?: was)? )?aborted[.!]?$/i.test(text);
}
