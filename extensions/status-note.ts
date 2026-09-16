/**
 * 「状态提示」文案的纯函数部分（便于单元测试）。
 *
 * 模型 / 思考级别的任何切换都统一成同一形式：
 * `模型已切换为\`模型id · 思考级别\``，不单独为思考级别出提示。
 * 反引号由前端渲染成行内代码样式。
 */
export function statusNoteFor(modelId, thinking) {
  const model = String(modelId || "").trim();
  if (!model) return "";
  return `模型已切换为\`${model} · ${String(thinking || "off")}\``;
}
