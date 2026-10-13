import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atomWeb from "../extensions/index.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 生成速度（tok/s）的分子与分母都由扩展观测：状态栏那个数以前是
 * 「累计 usage.output ÷ 会话存活时长」，分母里混着空闲与工具执行，永远慢一个量级。
 * 现在只观测模型吐正文与思考的过程，并累计进 `.pi/atom/<sessionId>/web-state.json`
 * 的 `generation` —— 与 thinkingTimings 一样不依赖 Web 是否启动。
 */
test("generation totals count text and thinking only, and survive without a web client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "atom-generation-"));
  const events = new Map();
  const pi = {
    getSessionName: () => "test",
    events: { on() {} },
    on: (name, handler) => events.set(name, handler),
    registerCommand: () => {},
  };
  atomWeb(pi);
  let branch = [];
  const ctx = {
    cwd,
    isIdle: () => true,
    hasPendingMessages: () => false,
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "speed-session",
      getBranch: () => branch,
    },
  };
  try {
    await events.get("session_start")({}, ctx);
    const thinking = { type: "thinking", thinking: "x".repeat(140) }; // 40 token
    const text = { type: "text", text: "y".repeat(35) }; // 10 token
    const toolCall = {
      type: "toolCall",
      name: "write",
      // 工具调用参数再大也不算进速度：provider 的 usage.output 把它和正文混在一起，
      // 这里按「正文 + 思考」的口径把它排除掉。
      arguments: { content: "z".repeat(20000) },
    };
    await events.get("message_start")(
      { message: { role: "assistant", content: [thinking] } },
      ctx,
    );
    await sleep(20);
    await events.get("message_update")(
      { message: { role: "assistant", content: [thinking, text] } },
      ctx,
    );
    await sleep(20);
    await events.get("message_end")(
      { message: { role: "assistant", content: [thinking, text, toolCall] } },
      ctx,
    );
    branch = [
      {
        type: "message",
        id: "entry-1",
        timestamp: Date.now(),
        message: { role: "assistant", content: [thinking, text, toolCall] },
      },
    ];
    await events.get("agent_settled")({}, ctx);

    await events.get("session_shutdown")();
    const state = JSON.parse(
      await readFile(
        join(cwd, ".pi", "atom", "speed-session", "web-state.json"),
        "utf8",
      ),
    );
    assert.equal(state.generation.messages, 1);
    // 50 token = 思考 40 + 正文 10，不含那 20000 个字符的工具调用参数。
    assert.equal(state.generation.tokens, 50);
    assert.ok(state.generation.ms >= 40, `生成时长应覆盖两次流式间隔，实际 ${state.generation.ms}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
