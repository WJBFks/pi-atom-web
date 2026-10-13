import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atomWeb from "../extensions/index.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 思考计时与落盘是扩展侧（pi 扩展 API）的职责：扩展被 pi 自动加载后，
 * 事件流就一直在那儿，**不需要 Web UI 打开、也不需要 `/web` 启动 HTTP 服务**。
 * 这里故意不创建 server、不接任何 SSE 客户端，只驱动 pi 事件，
 * 验证 `.pi/atom/<sessionId>/web-state.json` 里确实出现了 thinkingTimings。
 */
test("thinking timings are recorded and persisted with no web server and no client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "atom-thinking-"));
  const events = new Map();
  const pi = {
    getSessionName: () => "test",
    events: { on() {} },
    on: (name, handler) => events.set(name, handler),
    registerCommand: () => {},
  };
  atomWeb(pi);

  // Pi 在 message_end 之后才把消息写进 branch，所以分支内容由 branch 变量逐步填充。
  let branch = [];
  const ctx = {
    cwd,
    isIdle: () => true,
    hasPendingMessages: () => false,
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "timed-session",
      getBranch: () => branch,
    },
  };

  try {
    await events.get("session_start")({}, ctx);

    const content = [
      { type: "thinking", thinking: "先想一下要改哪里" },
      { type: "text", text: "答案" },
    ];
    await events.get("message_start")(
      { message: { role: "assistant", content: [content[0]] } },
      ctx,
    );
    await sleep(20);
    await events.get("message_update")(
      { message: { role: "assistant", content } },
      ctx,
    );
    await events.get("message_end")({ message: { role: "assistant", content } }, ctx);

    // Pi 落盘：现在 branch 里能看到那条 assistant 消息了。
    branch = [
      { type: "message", id: "entry-1", message: { role: "user", content: "问题" } },
      { type: "message", id: "entry-2", message: { role: "assistant", content } },
    ];

    // publish 的合并定时器（32ms）→ displayMessages 认领 entry → migrate → persistState
    // 的写盘防抖（100ms）。
    await sleep(400);

    const saved = JSON.parse(
      await readFile(join(cwd, ".pi", "atom", "timed-session", "web-state.json"), "utf8"),
    );
    const timings = Object.entries(saved.thinkingTimings);
    assert.equal(timings.length, 1, `期望一条思考计时，实际 ${JSON.stringify(saved.thinkingTimings)}`);
    const [key, timing] = timings[0];
    assert.equal(key, "timed-session:branch:entry-2-thinking-0");
    assert.ok(Number.isFinite(timing.startedAt));
    assert.ok(Number.isFinite(timing.durationMs) && timing.durationMs >= 15);

    await events.get("session_shutdown")();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
