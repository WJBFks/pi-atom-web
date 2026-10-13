import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStateStore } from "../extensions/session-state.ts";

test("session state is isolated by workspace and session and survives a new store", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "atom-state-"));
  try {
    const store = createSessionStateStore({ cwd, sessionId: "session-1", debounceMs: 5 });
    assert.deepEqual(await store.load(), {
      schemaVersion: 1, toolTimings: {}, thinkingTimings: {}, compactionTimings: {},
      compactionReasons: {},
      disclosures: {}, displayRecords: [], steeringDeliveries: [], turnProcessing: {},
      generation: { tokens: 0, ms: 0, messages: 0 },
    });
    store.update((state) => {
      state.toolTimings.tool = { startedAt: 10, endedAt: 30, durationMs: 20 };
      state.thinkingTimings.thought = { startedAt: 12, durationMs: 18 };
      // 生成速度的累计观测（只含正文与思考）：重启后均值不能归零
      state.generation = { tokens: 1200, ms: 6000, messages: 3 };
      // 自动压缩的耗时按压缩条目 id 索引，刷新后仍能显示在折叠块标题右侧
      state.compactionTimings["entry-auto"] = { startedAt: 11, durationMs: 34_000 };
      // 压缩触发原因（手动 / 自动）：前端分流靠它，同样要落盘
      state.compactionReasons["entry-auto"] = "threshold";
      state.disclosures.thought = true;
      // 引导送达只存 `{hash}:{长度}` 短签名，不存 Prompt 原文
      state.steeringDeliveries.push("abc123:9", "", 42, "x".repeat(200));
      state.displayRecords.push({ id: "record", sessionId: "session-1", anchor: null, message: { role: "command", content: "/name test" } });
    });
    await store.flush();
    const file = join(cwd, ".pi", "atom", "session-1", "web-state.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).toolTimings.tool.durationMs, 20);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).compactionTimings["entry-auto"].durationMs,
      34_000,
    );
    const restored = createSessionStateStore({ cwd, sessionId: "session-1" });
    assert.deepEqual(await restored.load(), store.value());
    assert.equal(restored.value().compactionReasons["entry-auto"], "threshold");
    assert.deepEqual(restored.value().generation, { tokens: 1200, ms: 6000, messages: 3 });
    assert.deepEqual(store.value().steeringDeliveries, ["abc123:9"]);
    await restored.close();
    await store.close();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("corrupt or unsupported session state safely becomes empty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "atom-state-bad-"));
  try {
    const directory = join(cwd, ".pi", "atom", "session-2");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "web-state.json"), "{broken");
    const store = createSessionStateStore({ cwd, sessionId: "session-2" });
    assert.deepEqual((await store.load()).toolTimings, {});
    await writeFile(join(directory, "web-state.json"), JSON.stringify({ schemaVersion: 2 }));
    assert.deepEqual((await createSessionStateStore({ cwd, sessionId: "session-2" }).load()).disclosures, {});
    await store.close();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// 状态提示 / 中止提示的 display 记录必须能落盘并恢复：
// session-state 原先只白名单了 ["command","notification"]，新角色会被静默丢弃。
test("status and interrupted display records survive a persist and restore round trip", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-atom-web-state-"));
  try {
    const store = await createSessionStateStore({ cwd, sessionId: "roundtrip" });
    store.replace({
      schemaVersion: 1,
      toolTimings: {},
      thinkingTimings: {},
      disclosures: {},
      displayRecords: [
        { id: "r1", sessionId: "roundtrip", anchor: null, message: { role: "status", content: "模型已切换为`x · high`" } },
        { id: "r2", sessionId: "roundtrip", anchor: null, message: { role: "interrupted", content: "操作已中断", level: "tool-aborted", detail: "Operation aborted" } },
        { id: "r3", sessionId: "roundtrip", anchor: null, message: { role: "command", content: "/help" } },
        // 不在白名单里的角色仍应被丢弃
        { id: "r4", sessionId: "roundtrip", anchor: null, message: { role: "tool", content: "drop" } },
      ],
    });
    await store.flush();
    await store.close();

    const reopened = await createSessionStateStore({ cwd, sessionId: "roundtrip" });
    const state = await reopened.load();
    await reopened.close();
    assert.deepEqual(
      state.displayRecords.map((record) => record.message.role).sort(),
      ["command", "interrupted", "status"],
    );
    assert.equal(
      state.displayRecords.find((record) => record.message.role === "status").message.content,
      "模型已切换为`x · high`",
    );
    assert.equal(
      state.displayRecords.find((record) => record.message.role === "interrupted").message.detail,
      "Operation aborted",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// 每一轮的处理时长要落盘：刷新后「已完成（时长）」才能继续贴在对应轮次的输出下方。
test("turnProcessing survives a persist and restore round trip", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-atom-web-turn-"));
  try {
    const store = await createSessionStateStore({ cwd, sessionId: "turns" });
    store.replace({
      schemaVersion: 1,
      toolTimings: {},
      thinkingTimings: {},
      disclosures: {},
      displayRecords: [],
      turnProcessing: {
        "turns:branch:a": { startedAt: 100, durationMs: 90_000 },
        "turns:branch:b": { startedAt: 200, durationMs: 5_000 },
        // 非数值的项必须被丢弃，不能让脏数据进内存
        "turns:branch:bad": { startedAt: "x", durationMs: 1 },
      },
    });
    await store.flush();
    await store.close();

    const reopened = await createSessionStateStore({ cwd, sessionId: "turns" });
    const state = await reopened.load();
    await reopened.close();
    assert.deepEqual(Object.keys(state.turnProcessing).sort(), [
      "turns:branch:a",
      "turns:branch:b",
    ]);
    assert.deepEqual(state.turnProcessing["turns:branch:a"], {
      startedAt: 100,
      durationMs: 90_000,
      status: "done",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// 压缩触发原因是前端分流（手动=页面边界 / 自动=本轮的一步）的唯一依据，而宿主只在事件里给，
// 所以必须落盘；非法值要丢掉，不能让脏数据进内存再进协议。
test("compactionReasons persist and drop unknown reasons", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-atom-web-reasons-"));
  try {
    const store = createSessionStateStore({ cwd, sessionId: "reasons", debounceMs: 5 });
    store.update((state) => {
      state.compactionReasons["entry-manual"] = "manual";
      state.compactionReasons["entry-threshold"] = "threshold";
      state.compactionReasons["entry-overflow"] = "overflow";
      state.compactionReasons["entry-bad"] = "user";
      state.compactionReasons["entry-number"] = 1;
      state.compactionReasons[""] = "manual";
    });
    await store.flush();
    await store.close();

    const reopened = createSessionStateStore({ cwd, sessionId: "reasons" });
    assert.deepEqual(await reopened.load().then((state) => state.compactionReasons), {
      "entry-manual": "manual",
      "entry-threshold": "threshold",
      "entry-overflow": "overflow",
    });
    await reopened.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
