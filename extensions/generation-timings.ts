// 生成速度观测（后端权威，只观测「正文 + 思考」）。
//
// 为什么要有这个文件：状态栏的 tok/s 原先是「会话累计 usage.output ÷ 会话存活时长」，
// 分母里混着空闲（人在读消息 / 会话挂着不动）、工具执行、压缩与自动重试，分子却是
// 整段会话的输出，于是显示值必然比真实生成速度慢一个量级。
//
// 现在的口径（与用户 2026-09-23 的要求一致：只算模型消息输出与思考输出，时间也只算
// 这两样的时间）：
// - **时间**：内容块第一次在流式里出现 → 它后面出现下一个内容块（或整条消息结束）为止。
//   判据与 extensions/thinking-timings.ts 完全一致，工具调用参数、排队与 TTFT 都不计入。
// - **token**：provider 的 `usage.output` 把工具调用参数混在一起拆不出来（宿主只有
//   input/output/cacheRead/cacheWrite 四项），所以这里按字符估算，只统计 text 与
//   thinking 两块。估算有 ±20% 的误差，界面上必须带「估算」字样，不能当权威值展示。
//
// 观测不到的消息（扩展加载之前的历史、被强杀在半路没收到任何流式增量的消息）不计入
// 累计值 —— 宁可少统计，也不用「会话时长」这类会被稀释的分母去凑一个数。

/** 中日韩汉字、假名、全角标点：这些字符在主流分词器里大约 0.7 个 token 一个字。 */
const CJK =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const TOKENS_PER_CJK_CHAR = 0.7;
const TOKENS_PER_OTHER_CHAR = 1 / 3.5;

/**
 * 按字符估算 token 数（估算值，不是 provider 的权威用量）。
 * 中英文分别加权：纯按 4 字符/token 估算会把中文严重算少（一个汉字通常就占一个 token 上下）。
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  let cjk = 0;
  // 按码点遍历，避免 emoji / 生僻字（代理对）被算成两个普通字符。
  for (const char of text) if (CJK.test(char)) cjk += 1;
  const codePoints = [...text].length;
  return Math.max(
    0,
    Math.round(
      cjk * TOKENS_PER_CJK_CHAR +
        (codePoints - cjk) * TOKENS_PER_OTHER_CHAR,
    ),
  );
}

/** 取一个内容块里「模型自己写的文本」；不是正文/思考的块（工具调用等）返回 null。 */
function blockText(block) {
  if (block?.type === "text") return block.text || "";
  if (block?.type === "thinking") return block.thinking || "";
  return null;
}

/** 一条消息里正文 + 思考的估算 token 数。 */
export function messageContentTokens(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let tokens = 0;
  for (const block of blocks) {
    const text = blockText(block);
    if (text !== null) tokens += estimateTokens(text);
  }
  return tokens;
}

/**
 * 返回 { track, settle, finish, reset, streaming, observed }。
 * 调用点与 thinkingTracker 一一对应：message_start 里 reset+track，message_update 里
 * track+settle，message_end（以及 agent_settled 兜底）里 finish 结算出这一条消息的
 * `{ tokens, ms, blocks }` 并累进会话总量。
 */
export function createGenerationTracker() {
  /** index -> { type, startedAt, tokens, durationMs? }；没有 durationMs = 还在生成 */
  const live = new Map();
  const blocksOf = (message) =>
    Array.isArray(message?.content) ? message.content : [];

  // 新的一条 assistant 消息开始。
  function reset() {
    live.clear();
  }

  // 块第一次出现即开始计时；仍在生成的块刷新 token 估算（流式增量会把文本补全）。
  function track(message) {
    const now = Date.now();
    for (const [index, block] of blocksOf(message).entries()) {
      const text = blockText(block);
      if (text === null) continue;
      const timing = live.get(index);
      if (!timing) live.set(index, { type: block.type, startedAt: now, tokens: estimateTokens(text) });
      else if (timing.durationMs == null) timing.tokens = estimateTokens(text);
    }
  }

  // 块后面已经出现其它内容块 → 它不再在生成，立即结算时长。
  function settle(message) {
    const lastIndex = blocksOf(message).length - 1;
    const now = Date.now();
    for (const [index, timing] of live) {
      if (timing.durationMs == null && index < lastIndex)
        timing.durationMs = now - timing.startedAt;
    }
  }

  function total() {
    let tokens = 0,
      ms = 0,
      blocks = 0;
    for (const timing of live.values()) {
      if (timing.durationMs == null) continue;
      tokens += timing.tokens;
      ms += timing.durationMs;
      blocks += 1;
    }
    return { tokens, ms, blocks };
  }

  /**
   * 结算并清空。`message` 缺席时（强杀在半路）用最后一次流式刷新到的 token 估算，
   * 时长结算到此刻。没有任何已结算的块 → 返回 null，调用方不必累加。
   */
  function finish(message) {
    if (message !== undefined) settle(message);
    const now = Date.now();
    for (const timing of live.values())
      if (timing.durationMs == null) timing.durationMs = now - timing.startedAt;
    const result = total();
    live.clear();
    return result.blocks ? result : null;
  }

  /**
   * 正在生成的这条消息的实时观测值：`{ startedAt, elapsedMs, estimatedTokens }`。
   * elapsedMs 只累加「正文/思考真正在生成」的那段时间（已结算块 + 未结算块至今），
   * 所以它同时排除了排队、TTFT、工具执行与空闲。没有任何正文/思考时返回 null。
   */
  function streaming(now = Date.now()) {
    let elapsedMs = 0,
      estimatedTokens = 0,
      startedAt = null;
    for (const timing of live.values()) {
      if (startedAt === null || timing.startedAt < startedAt)
        startedAt = timing.startedAt;
      if (timing.durationMs == null) {
        elapsedMs += Math.max(0, now - timing.startedAt);
        estimatedTokens += timing.tokens;
      } else {
        elapsedMs += timing.durationMs;
        estimatedTokens += timing.tokens;
      }
    }
    if (startedAt === null || elapsedMs <= 0) return null;
    return { startedAt, elapsedMs, estimatedTokens };
  }

  return { track, settle, finish, reset, streaming, observed: total };
}
