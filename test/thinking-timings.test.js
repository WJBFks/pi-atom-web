import test from "node:test";
import assert from "node:assert/strict";
import { createThinkingTracker } from "../extensions/thinking-timings.ts";

const think = () => ({ type: "thinking", thinking: "..." });
const text = () => ({ type: "text", text: "hi" });
const call = () => ({ type: "toolCall", name: "bash", arguments: {} });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("首次出现的思考块开始计时，重复更新不重置起点", async () => {
  const tracker = createThinkingTracker();
  const t0 = Date.now();
  tracker.track({ content: [think()] });
  await sleep(15);
  tracker.track({ content: [think()] }); // 同一块仍在流式更新
  await sleep(15);
  const { 0: timing } = tracker.finish();
  // 起点被重复更新重置的话 durationMs 只会是 ~15ms；实际应为 ~30ms
  assert.ok(timing.durationMs >= 25, `durationMs=${timing.durationMs}`);
  assert.ok(timing.startedAt <= t0 + 5, `startedAt=${timing.startedAt} t0=${t0}`);
});

test("思考块后面出现正文/工具块时立即结算，后续时间不计入", async () => {
  const tracker = createThinkingTracker();
  tracker.track({ content: [think()] });
  await sleep(25);
  tracker.track({ content: [think(), text()] });
  tracker.settle({ content: [think(), text()] });
  // 中间再推一帧也不应继续计时
  await sleep(25);
  tracker.settle({ content: [think(), text()] });
  const { 0: timing } = tracker.finish();
  assert.ok(timing.durationMs != null);
  // 结算发生在第二帧，25ms 后不应再涨：durationMs 应明显小于两次 sleep 之和
  assert.ok(timing.durationMs < 50, `durationMs=${timing.durationMs}`);
});

test("消息末尾的思考块在 finish 时结算", async () => {
  const tracker = createThinkingTracker();
  tracker.track({ content: [think()] });
  await sleep(20);
  const out = tracker.finish();
  const timing = out[0];
  assert.ok(timing.startedAt > 0);
  assert.ok(timing.endedAt >= timing.startedAt);
  assert.equal(timing.durationMs, timing.endedAt - timing.startedAt);
  // finish 后状态清空
  assert.deepEqual(tracker.finish(), {});
});

test("一条消息里多个思考块按内容块下标记录", async () => {
  const tracker = createThinkingTracker();
  tracker.track({ content: [think()] });
  await sleep(10);
  tracker.track({ content: [think(), text()] });
  tracker.settle({ content: [think(), text()] });
  await sleep(10);
  tracker.track({ content: [think(), text(), think()] });
  tracker.settle({ content: [think(), text(), think()] });
  await sleep(10);
  const out = tracker.finish();
  assert.deepEqual(Object.keys(out).map(Number).sort((a, b) => a - b), [0, 2]);
  // 下标 0 在出现正文时就结算；下标 2 在 finish 时结算
  assert.ok(out[0].durationMs >= 0);
  assert.ok(out[2].durationMs >= 0);
});

test("非思考内容与空消息不影响状态", () => {
  const tracker = createThinkingTracker();
  tracker.track({ content: "plain string" });
  tracker.track({ content: null });
  tracker.track(undefined);
  tracker.settle({ content: [text(), call()] });
  assert.deepEqual(tracker.finish(), {});
});

test("reset 丢弃未结算状态", () => {
  const tracker = createThinkingTracker();
  tracker.track({ content: [think()] });
  tracker.reset();
  assert.deepEqual(tracker.finish(), {});
});
