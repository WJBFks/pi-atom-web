// 思考块计时（后端权威）。
//
// 计时与落盘只依赖扩展 API 的事件流（message_start / message_update /
// message_end），不再要求 Web 已启动或有浏览器在线 —— 之前由浏览器计时、
// 再经 save_ui_state 回传落盘，Web 未启动时整条链路都不存在，思考时长就丢了。
//
// 判据与前端历史逻辑一致：
// - 思考块第一次出现时开始计时（startedAt）；
// - 同一条消息里它后面一旦出现任何其它内容块（正文 / 工具调用），即结束
//   （durationMs 只计到那一刻，后续输出时间不计入思考）；
// - 位于消息末尾的思考块在消息结束时结算。
//
// key 格式与前端 ThinkingBlock 的 blockKey 完全一致：
// `<messageId>-thinking-<index>`（index 是内容块下标，不是第几个思考块），
// 前端直接读快照里的 thinkingTimings 展示，不再自行计算/回传。

/** 返回 { track, settle, finish, reset } */
export function createThinkingTracker() {
  /** 当前流式消息的思考块状态：index -> { startedAt } 或 { startedAt, endedAt, durationMs } */
  const live = new Map();
  const blocksOf = (message) =>
    Array.isArray(message?.content) ? message.content : [];

  // 首次出现的思考块开始计时。message_start 与 message_update 都调用。
  function track(message) {
    const blocks = blocksOf(message);
    for (const [index, block] of blocks.entries()) {
      if (block?.type === "thinking" && !live.has(index))
        live.set(index, { startedAt: Date.now() });
    }
  }

  // 思考块后面已经出现其它内容块 → 立即结算。
  function settle(message) {
    const lastIndex = blocksOf(message).length - 1;
    for (const [index, timing] of live) {
      if (timing.durationMs != null || index >= lastIndex) continue;
      const endedAt = Date.now();
      live.set(index, {
        ...timing,
        endedAt,
        durationMs: endedAt - timing.startedAt,
      });
    }
  }

  // 消息结束：结算尚未结算的思考块（末尾的思考），清空当前消息状态，
  // 返回 { index -> timing }；空消息返回空对象。
  function finish() {
    const out = {};
    for (const [index, timing] of live) {
      const settled =
        timing.durationMs == null
          ? (() => {
              const endedAt = Date.now();
              return {
                ...timing,
                endedAt,
                durationMs: endedAt - timing.startedAt,
              };
            })()
          : timing;
      out[index] = settled;
    }
    live.clear();
    return out;
  }

  // 新的一条 assistant 消息开始。
  function reset() {
    live.clear();
  }

  return { track, settle, finish, reset };
}
