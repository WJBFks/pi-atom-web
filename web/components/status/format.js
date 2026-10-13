const number = (value) => Number(value) || 0;
export function compactNumber(value) {
  const n = number(value);
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, "")}M`;
  if (n >= 1e3)
    return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}
export function elapsedText(start, end = Date.now()) {
  const seconds = Math.max(
    0,
    Math.floor((number(end) - (number(start) || number(end))) / 1000),
  );
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return [
    hours && `${hours}时`,
    (hours || minutes) && `${minutes}分`,
    `${seconds % 60}秒`,
  ]
    .filter(Boolean)
    .join(" ");
}
const dateText = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
/**
 * 生成速度（tok/s）：只算模型生成「正文 + 思考」的那段过程。
 *
 * 分子是后端按字符折算的 token（工具调用参数不计入），分母是实测的生成时长：
 * 空闲、工具执行、上下文压缩与排队都不在分母里。所以它是真实的生成速度，
 * 不再是以前那个被会话存活时长稀释了一堆的「累计 output ÷ 会话开了多久」。
 *
 * **历史累计 + 当前这条消息的实时观测合并成一个数**（用户 2026-09-23 要求）：
 * 生成中也给同一个口径的均值，不再另做一个只算当前消息的实时值，也不加「≈」。
 */
export function averageSpeed(session) {
  const totals = (session && session.stats && session.stats.generation) || {};
  const live = session.liveGeneration;
  let tokens = number(totals.tokens),
    ms = number(totals.ms);
  if (live && typeof live === "object") {
    tokens += number(live.estimatedTokens);
    ms += number(live.elapsedMs);
  }
  if (!(tokens > 0) || !(ms > 0)) return null;
  return tokens / (ms / 1000);
}
export function statusValues(session, now = Date.now()) {
  const stats = session.stats || {},
    usage = stats.usage || {},
    speed = averageSpeed(session);
  // 拆成三段（而不是拼成一整串）是为了状态栏能在宽度不够时**逐段**隐藏（轮 → 步 → 输入/输出…）。
  // `conversation` 保留原来的整串，给弹层与既有断言用。
  const turns = `${number(stats.rounds)}轮`,
    steps = `${number(stats.events)}步`,
    speedText = speed === null ? "—" : `${speed.toFixed(1)} tok/s`,
    // 命中率与成本也要能分开隐（第 6 级只隐成本），同样保留 `cache` 整串。
    hit = `${(number(stats.cacheHit) * 100).toFixed(1)}%`,
    cost = `$${number(usage.cost).toFixed(2)}`;
  return {
    session: session.name || "未命名会话",
    conversation: `${turns}${steps} · ${speedText}`,
    turns,
    steps,
    speedText,
    input: compactNumber(usage.input),
    output: compactNumber(usage.output),
    total: compactNumber(usage.total),
    cache: `${hit}　${cost}`,
    hit,
    cost,
    speed,
  };
}
// 上下文占用（输入框旁的占比圆环与点击弹层）——纯函数，给单独断言留出余地。
// 只有三档颜色（全站一致：正常=灰 / 警告=橙 / 报错=红），85% 以上转红、60% 起转橙；
// 拿不到数值（旧运行时、刚压缩完还没有新用量）时 level 是 unknown，环只画底图。
export function contextUsageView(session) {
  const usage = (session && session.contextUsage) || null;
  const tokens = usage && Number.isFinite(usage.tokens) ? usage.tokens : null;
  const capacity =
    usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : null;
  const percent = usage && Number.isFinite(usage.percent) ? usage.percent : null;
  return {
    tokens,
    capacity,
    percent,
    ratio: percent === null ? 0 : Math.min(Math.max(percent, 0), 100) / 100,
    level:
      percent === null
        ? "unknown"
        : percent >= 85
          ? "danger"
          : percent >= 60
            ? "warn"
            : "ok",
    label:
      percent === null
        ? "上下文占比未知"
        : `上下文占比 ${percent.toFixed(1)}%${
            tokens === null || capacity === null
              ? ""
              : `（${tokens.toLocaleString()} / ${capacity.toLocaleString()} token）`
          }`,
  };
}
export function statusRows(kind, session, now = Date.now()) {
  const stats = session.stats || {},
    usage = stats.usage || {},
    workspace = stats.workspace || {};
  const row = (label, value, copy) => ({
    label,
    value: String(value ?? "—"),
    ...(copy == null ? {} : { copy: String(copy) }),
  });
  const amount = (label, value) =>
    row(label, number(value).toLocaleString(), number(value));
  if (kind === "session")
    return [
      row("会话 ID", session.sessionId, session.sessionId),
      row("会话文件路径", stats.sessionFile, stats.sessionFile),
      row("所在工作区", workspace.name, workspace.name),
      row("所在工作区路径", workspace.path, workspace.path),
      row("活跃时间", dateText(stats.activeAt), dateText(stats.activeAt)),
      row("创建时间", dateText(stats.startedAt), dateText(stats.startedAt)),
      row("活跃时长", elapsedText(stats.startedAt, stats.activeAt)),
    ];
  if (kind === "conversation") {
    return [
      row("对话轮数", number(stats.rounds)),
      row("轨迹事件数", number(stats.events)),
      row(
        "平均输出速度",
        averageSpeed(session) === null
          ? "—"
          : `${averageSpeed(session).toFixed(1)} tok/s`,
      ),
      row("活跃时长", elapsedText(stats.startedAt, now)),
    ];
  }
  if (kind === "tokens")
    return [
      amount("输入", usage.input),
      amount("输出", usage.output),
      amount("缓存读取", usage.cacheRead),
      amount("缓存写入", usage.cacheWrite),
      amount("总计", usage.total),
    ];
  if (kind === "context") {
    const view = contextUsageView(session);
    return [
      row(
        "当前上下文",
        view.tokens === null ? "计算中" : `${view.tokens.toLocaleString()} token`,
      ),
      row(
        "最大上下文",
        view.capacity === null
          ? "未知"
          : `${view.capacity.toLocaleString()} token`,
      ),
      row(
        "上下文占比",
        view.percent === null ? "计算中" : `${view.percent.toFixed(1)}%`,
      ),
    ];
  }
  return [
    row("缓存命中率", `${(number(stats.cacheHit) * 100).toFixed(1)}%`),
    amount("缓存读取 Token", usage.cacheRead),
    amount(
      "输入与缓存 Token",
      number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite),
    ),
    row("成本", `$${number(usage.cost).toFixed(4)}`, number(usage.cost)),
  ];
}
