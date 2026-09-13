import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRunningTool } from "../extensions/tool-events.ts";

test("running tool events become bounded JSON-safe protocol values", () => {
  const circular = { visible: "ok", count: 12n };
  circular.self = circular;
  Object.defineProperty(circular, "broken", {
    enumerable: true,
    get() {
      throw new Error("getter must not escape");
    },
  });

  const tool = normalizeRunningTool(
    {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "custom",
      args: { command: "run" },
      partialResult: {
        content: [{ type: "text", text: "progress" }],
        details: circular,
      },
      privateHandle: () => {},
    },
    { startedAt: 123 },
  );

  assert.deepEqual(Object.keys(tool), [
    "toolCallId",
    "toolName",
    "args",
    "partialResult",
    "startedAt",
  ]);
  assert.equal(tool.partialResult.details.count, "12");
  assert.equal(tool.partialResult.details.self, "[Circular]");
  assert.match(tool.partialResult.details.broken, /Unavailable/);
  assert.doesNotThrow(() => JSON.stringify(tool));
});

test("running tool normalization limits oversized output", () => {
  const tool = normalizeRunningTool({
    toolCallId: "call-large",
    toolName: "read",
    args: {},
    partialResult: { content: [{ type: "text", text: "x".repeat(400_000) }] },
  });
  assert.ok(JSON.stringify(tool).length <= 270_000);
  assert.match(tool.partialResult.content[0].text, /\[truncated\]$/);
});

test("array element getters cannot escape tool normalization", () => {
  const values = [];
  Object.defineProperty(values, 0, {
    enumerable: true,
    get() {
      throw new Error("array boom");
    },
  });
  values.length = 1;
  const tool = normalizeRunningTool({
    toolCallId: "array-getter",
    toolName: "custom",
    partialResult: { content: values },
  });
  assert.match(tool.partialResult.content[0], /Unavailable/);
  assert.doesNotThrow(() => JSON.stringify(tool));
});

test("a thrown value with a hostile message getter cannot escape normalization", () => {
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("message boom");
    },
  });
  const value = {};
  Object.defineProperty(value, "broken", {
    enumerable: true,
    get() {
      throw hostile;
    },
  });
  const tool = normalizeRunningTool({
    toolCallId: "hostile-error",
    toolName: "custom",
    partialResult: value,
  });
  assert.match(tool.partialResult.broken, /Unavailable/);
  assert.doesNotThrow(() => JSON.stringify(tool));
});

test("long keys and non-string values count toward the final tool event limit", () => {
  const wide = {};
  for (let index = 0; index < 4096; index++)
    wide[`${index}-${"k".repeat(1000)}`] = index;
  const tool = normalizeRunningTool({
    toolCallId: "i".repeat(400_000),
    toolName: "n".repeat(400_000),
    args: wide,
    partialResult: wide,
  });
  assert.ok(JSON.stringify(tool).length <= 256 * 1024);
});
