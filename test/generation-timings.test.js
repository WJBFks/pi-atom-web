import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenerationTracker,
  estimateTokens,
  messageContentTokens,
} from "../extensions/generation-timings.ts";

/** 把 Date.now 换成手动时钟：每 tick 前进 500ms，断言时长不依赖真实速度。 */
function withClock(body) {
  const real = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    body(() => {
      now += 500;
    });
  } finally {
    Date.now = real;
  }
}

test("token estimation weights cjk apart from latin", () => {
  // 140 个拉丁字符 ≈ 40 token（3.5 字符 / token）。
  assert.equal(estimateTokens("x".repeat(140)), 40);
  // 20 个汉字 ≈ 14 token（0.7 token / 字），按 3.5 字符/token 会低估到 6。
  assert.equal(estimateTokens("中".repeat(20)), 14);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
  // 混合文本两档相加：10 × 0.7 + 35 / 3.5 = 17。
  assert.equal(estimateTokens("中".repeat(10) + "x".repeat(35)), 17);
  // 代理对算一个码点，不被当成两个拉丁字符。
  assert.equal(estimateTokens("🙂".repeat(10)), Math.round(10 / 3.5));
});

test("content tokens count only assistant text and thinking", () => {
  assert.equal(
    messageContentTokens({
      content: [
        { type: "thinking", thinking: "x".repeat(35) },
        { type: "text", text: "x".repeat(35) },
        // 工具调用参数是模型生成的，但 provider 把它混在 usage.output 里拆不出来，
        // 速度口径不收它。
        { type: "toolCall", name: "write", arguments: { content: "y".repeat(4000) } },
      ],
    }),
    20,
  );
});

test("generation tracker times text and thinking but not tool calls", () => {
  withClock((tick) => {
    const tracker = createGenerationTracker();
    tracker.reset();
    // 1000ms：思考块第一次出现，开始计时。
    tracker.track({ content: [{ type: "thinking", thinking: "x".repeat(70) }] });
    // 刚开始生成的瞬间没有经过时间：不给 0 分母。
    assert.equal(tracker.streaming(), null);
    tick();
    // 1500ms：正文出现 → 思考块就此结束（后续输出时间不算思考）。
    const withText = {
      content: [
        { type: "thinking", thinking: "x".repeat(70) },
        { type: "text", text: "x".repeat(70) },
      ],
    };
    tracker.track(withText);
    tracker.settle(withText);
    assert.deepEqual(tracker.streaming(), {
      startedAt: 1_000,
      elapsedMs: 500,
      estimatedTokens: 40,
    });
    tick();
    // 2000ms：消息结束，末尾的正文块结算到这里。
    assert.deepEqual(tracker.finish(withText), {
      tokens: 40,
      ms: 1_000,
      blocks: 2,
    });
    assert.equal(tracker.finish(withText), null);
  });
});

test("generation tracker excludes tool argument time and survives missing messages", () => {
  withClock((tick) => {
    const tracker = createGenerationTracker();
    tracker.reset();
    tracker.track({ content: [{ type: "text", text: "x".repeat(35) }] });
    tick();
    const withTool = {
      content: [
        { type: "text", text: "x".repeat(35) },
        { type: "toolCall", name: "bash", arguments: { command: "sleep 60" } },
      ],
    };
    tracker.track(withTool);
    tracker.settle(withTool);
    tick();
    tick();
    // 正文在 1500ms 就结束了（工具调用块出现），2000 / 2500ms 那两段时间属于工具，不收。
    assert.deepEqual(tracker.observed(), { tokens: 10, ms: 500, blocks: 1 });
    // 消息体丢了（强杀在半路）：用最后一次刷新到的估算把时长结算到此刻。
    assert.deepEqual(tracker.finish(), { tokens: 10, ms: 500, blocks: 1 });
  });
});
