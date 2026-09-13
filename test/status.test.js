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
test("status uses actual usage and estimated active duration without NaN for missing statistics", () => {
  assert.equal(statusValues(session, 11000).conversation, "2轮7步 · 2.0 tok/s");
  assert.equal(statusValues(session, 11000).session, "未命名会话");
  assert.equal(statusValues(session, 11000).cache, "40.0%　$0.12");
  assert.equal(statusValues({}, 11000).total, "0");
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
