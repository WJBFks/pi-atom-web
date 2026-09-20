import assert from "node:assert/strict";
import test from "node:test";

import { createSessionTreeBridge } from "../extensions/session-tree.ts";

test("session tree bridge prefers Pi command context navigation", async () => {
  const bridge = createSessionTreeBridge();
  const sessionManager = {};
  const calls = [];
  const session = {
    sessionManager,
    navigateTree() {
      assert.fail("internal AgentSession fallback should not run");
    },
  };
  const runner = {
    createCommandContext() {
      return {
        navigateTree(targetId, options) {
          calls.push({ targetId, options });
          return Promise.resolve({ cancelled: false });
        },
      };
    },
  };

  bridge.attach(session, runner);
  assert.equal(bridge.has(sessionManager), true);
  await bridge.navigate(sessionManager, "user-entry");
  assert.deepEqual(calls, [
    { targetId: "user-entry", options: { summarize: false } },
  ]);
});

test("session tree bridge falls back to the captured AgentSession", async () => {
  const bridge = createSessionTreeBridge();
  const sessionManager = {};
  const calls = [];
  bridge.attach({
    sessionManager,
    navigateTree(targetId, options) {
      calls.push({ targetId, options });
      return Promise.resolve({ cancelled: false });
    },
  });

  await bridge.navigate(sessionManager, "user-entry");
  assert.deepEqual(calls, [
    { targetId: "user-entry", options: { summarize: false } },
  ]);
});
