import test from "node:test";
import assert from "node:assert/strict";
import { statusRows, statusValues } from "../web/components/status/format.js";

const session = {
  sessionId: "sid",
  name: "",
  stats: {
    rounds: 2,
    events: 7,
    startedAt: 1000,
    activeAt: 2000,
    sessionFile: "memory",
    workspace: { name: "repo", path: "C:/repo" },
    usage: {
      input: 12,
      output: 20,
      cacheRead: 8,
      cacheWrite: 0,
      total: 40,
      cost: 0.1234,
    },
    cacheHit: 0.4,
  },
};
// 后端实测的生成观测（只含正文与思考）：400 token / 20 秒 = 20 tok/s。
const observed = {
  ...session,
  stats: {
    ...session.stats,
    generation: { tokens: 400, ms: 20000, messages: 2 },
  },
};
test("status uses actual usage and estimated active duration without NaN for missing statistics", () => {
  assert.equal(statusValues(session, 11000).conversation, "2轮7步 · —");
  assert.equal(statusValues(session, 11000).session, "未命名会话");
  assert.equal(statusValues(session, 11000).cache, "40.0%　$0.12");
  assert.equal(statusValues({}, 11000).total, "0");
});
test("speed counts only observed text/thinking generation, never the session lifetime", () => {
  // 有观测：400 / 20s = 20.0 tok/s（旧算法在这里会算成 usage.output ÷ 会话存活时长）。
  assert.equal(statusValues(observed, 11000).conversation, "2轮7步 · 20.0 tok/s");
  assert.equal(statusValues(observed, 11000).speed, 20);
  // 生成中：历史累计与当前消息的实时观测**合算成一个均值**，不加「≈」也不另起一行。
  const live = {
    ...observed,
    liveGeneration: { startedAt: 9000, elapsedMs: 4000, estimatedTokens: 400 },
  };
  // (400 + 400) token / (20s + 4s) = 33.3 tok/s
  assert.equal(statusValues(live, 11000).conversation, "2轮7步 · 33.3 tok/s");
  assert.equal(statusValues(live, 11000).speed, 800 / 24);
  // 弹层只有一行速度：标签不带「（正文与思考）」这类后缀。
  assert.deepEqual(
    statusRows("conversation", live, 11000).map((row) => row.label),
    ["对话轮数", "轨迹事件数", "平均输出速度", "活跃时长"],
  );
  assert.equal(statusRows("conversation", live, 11000)[2].value, "33.3 tok/s");
  // 完全没有观测时不能编一个数出来。
  assert.equal(statusRows("conversation", session, 11000)[2].value, "—");
});
test("session details use requested order without duplicating title and copy raw usage", () => {
  assert.deepEqual(
    statusRows("session", session, 11000).map((row) => row.label),
    [
      "会话 ID",
      "会话文件路径",
      "所在工作区",
      "所在工作区路径",
      "活跃时间",
      "创建时间",
      "活跃时长",
    ],
  );
  assert.equal(statusRows("tokens", session, 11000)[0].copy, "12");
  assert.equal(statusRows("cache", session, 11000).at(-1).copy, "0.1234");
});
