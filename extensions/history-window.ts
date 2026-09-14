// 历史分页：首屏只带最近若干轮，更早的由客户端用 more_history 按游标向前懒加载。
// 这里只做纯计算，便于单测（extensions/index.ts 与浏览器端行为都要围绕它对齐）。
export const HISTORY_TURNS = 10;
export const HISTORY_PAGE_TURNS = 5;

/** 一轮 = 一条用户消息及其后的过程；返回「最近 maxTurns 轮」的起始下标。 */
export function historyCutIndex(messages, maxTurns = HISTORY_TURNS) {
  let remaining = maxTurns;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    remaining -= 1;
    if (remaining <= 0) return index;
  }
  return 0;
}

/** 取 beforeIndex 之前、最多 maxTurns 轮的一段，返回切片与它在完整列表里的起点。 */
export function olderHistory(messages, beforeIndex, maxTurns = HISTORY_TURNS) {
  const start = historyCutIndex(messages.slice(0, beforeIndex), maxTurns);
  return { messages: messages.slice(start, beforeIndex), start };
}

/** 首屏窗口：最近若干轮 + 是否已经到最早一条。 */
export function windowedHistory(messages, maxTurns = HISTORY_TURNS) {
  const cut = historyCutIndex(messages, maxTurns);
  return { messages: messages.slice(cut), historyComplete: cut === 0 };
}
