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
      schemaVersion: 1, toolTimings: {}, thinkingTimings: {}, disclosures: {}, displayRecords: [],
    });
    store.update((state) => {
      state.toolTimings.tool = { startedAt: 10, endedAt: 30, durationMs: 20 };
      state.thinkingTimings.thought = { startedAt: 12, durationMs: 18 };
      state.disclosures.thought = true;
      state.displayRecords.push({ id: "record", sessionId: "session-1", anchor: null, message: { role: "command", content: "/name test" } });
    });
    await store.flush();
    const file = join(cwd, ".pi", "atom", "session-1", "web-state.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).toolTimings.tool.durationMs, 20);
    const restored = createSessionStateStore({ cwd, sessionId: "session-1" });
    assert.deepEqual(await restored.load(), store.value());
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
