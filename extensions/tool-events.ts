const MAX_TOOL_JSON_CHARS = 256 * 1024;
const MAX_DEPTH = 20;
const MAX_ITEMS = 4096;

function spend(budget, amount) {
  if (amount > budget.remaining || budget.nodes <= 0) return false;
  budget.remaining -= amount;
  budget.nodes -= 1;
  return true;
}

function boundedString(value, budget) {
  const encoded = JSON.stringify(value);
  if (spend(budget, encoded.length)) return value;
  const marker = "…[truncated]";
  let low = 0;
  let high = Math.min(value.length, budget.remaining);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      JSON.stringify(`${value.slice(0, middle)}${marker}`).length <=
      budget.remaining
    )
      low = middle;
    else high = middle - 1;
  }
  const result = `${value.slice(0, low)}${marker}`;
  spend(budget, JSON.stringify(result).length);
  return result;
}

function safeProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return "[Unavailable: property read failed]";
  }
}

/** Convert extension-owned tool data into bounded JSON without trusting custom getters. */
export function toToolJson(
  value,
  budget = { remaining: MAX_TOOL_JSON_CHARS, nodes: MAX_ITEMS },
  seen = new WeakSet(),
  depth = 0,
) {
  if (value === null || typeof value === "boolean") {
    spend(budget, JSON.stringify(value).length);
    return value;
  }
  if (typeof value === "number") {
    const result = Number.isFinite(value) ? value : String(value);
    spend(budget, JSON.stringify(result).length);
    return result;
  }
  if (typeof value === "bigint") return boundedString(String(value), budget);
  if (typeof value === "string") return boundedString(value, budget);
  if (typeof value === "undefined")
    return boundedString("[Unsupported: undefined]", budget);
  if (typeof value === "function" || typeof value === "symbol")
    return boundedString(`[Unsupported: ${typeof value}]`, budget);
  if (depth >= MAX_DEPTH || budget.remaining <= 0) return "[truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    let isArray = false;
    try {
      isArray = Array.isArray(value);
    } catch {
      return "[Unavailable: array read failed]";
    }
    if (isArray) {
      const result = [];
      let length = 0;
      try {
        length = Math.min(value.length, MAX_ITEMS);
      } catch {
        return "[Unavailable: array length failed]";
      }
      for (
        let index = 0;
        index < length && budget.remaining > 0 && budget.nodes > 0;
        index++
      )
        result.push(
          toToolJson(safeProperty(value, index), budget, seen, depth + 1),
        );
      return result;
    }
    const result = {};
    let keys;
    try {
      keys = Object.keys(value).slice(0, MAX_ITEMS);
    } catch {
      return "[Unavailable: object read failed]";
    }
    for (const key of keys) {
      if (!spend(budget, JSON.stringify(key).length + 2)) break;
      result[key] = toToolJson(
        safeProperty(value, key),
        budget,
        seen,
        depth + 1,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Keep only the fields consumed by ToolCallBlock; never expose tool-private handles. */
export function normalizeRunningTool(event, previous = {}) {
  const toolCallId =
    safeProperty(event, "toolCallId") ?? safeProperty(previous, "toolCallId");
  const toolName =
    safeProperty(event, "toolName") ?? safeProperty(previous, "toolName");
  const args = safeProperty(event, "args") ?? safeProperty(previous, "args");
  const partialResult =
    safeProperty(event, "partialResult") ??
    safeProperty(previous, "partialResult");
  const startedAt =
    safeProperty(previous, "startedAt") ?? safeProperty(event, "startedAt");
  const identifier = (value, fallback) => {
    try {
      return String(value ?? fallback).slice(0, 1024);
    } catch {
      return fallback;
    }
  };
  // Reserve room for field names, commas and the bounded identifiers around
  // the custom payload so useful output can be truncated in place.
  const budget = {
    remaining: MAX_TOOL_JSON_CHARS - 8192,
    nodes: MAX_ITEMS,
  };
  const result = {
    toolCallId: identifier(toolCallId, "unknown"),
    toolName: identifier(toolName, "tool"),
    ...(args !== undefined ? { args: toToolJson(args, budget) } : {}),
    ...(partialResult !== undefined
      ? { partialResult: toToolJson(partialResult, budget) }
      : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
  };
  if (JSON.stringify(result).length > MAX_TOOL_JSON_CHARS) {
    if ("partialResult" in result) result.partialResult = "[truncated]";
    if (JSON.stringify(result).length > MAX_TOOL_JSON_CHARS && "args" in result)
      result.args = "[truncated]";
  }
  return result;
}
