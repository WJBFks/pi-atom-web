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
export function statusValues(session, now = Date.now()) {
  const stats = session.stats || {},
    usage = stats.usage || {};
  const speed =
    number(usage.output) /
    Math.max(1, (now - (number(stats.startedAt) || now)) / 1000);
  return {
    session: session.name || "未命名会话",
    conversation: `${number(stats.rounds)}轮${number(stats.events)}步 · ${speed.toFixed(1)} tok/s`,
    input: compactNumber(usage.input),
    output: compactNumber(usage.output),
    total: compactNumber(usage.total),
    cache: `${(number(stats.cacheHit) * 100).toFixed(1)}%　$${number(usage.cost).toFixed(2)}`,
    speed,
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
  if (kind === "conversation")
    return [
      row("对话轮数", number(stats.rounds)),
      row("轨迹事件数", number(stats.events)),
      row(
        "平均输出速度（估算）",
        `${statusValues(session, now).speed.toFixed(1)} tok/s`,
      ),
      row("活跃时长", elapsedText(stats.startedAt, now)),
    ];
  if (kind === "tokens")
    return [
      amount("输入", usage.input),
      amount("输出", usage.output),
      amount("缓存读取", usage.cacheRead),
      amount("缓存写入", usage.cacheWrite),
      amount("总计", usage.total),
    ];
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
