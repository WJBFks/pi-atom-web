import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalSender,
  sanitizeLine,
} from "../web/components/dialogs/CustomTerminal.js";

test("terminal sender keeps the request session and stops queued chunks after disposal", async () => {
  const calls = [];
  let release;
  const first = new Promise((resolve) => {
    release = resolve;
  });
  const sender = createTerminalSender({
    requestId: "request-a",
    sessionId: "session-a",
    post: async (action) => {
      calls.push(action);
      if (calls.length === 1) await first;
    },
  });
  sender.send("a".repeat(5000));
  await new Promise((resolve) => setImmediate(resolve));
  sender.dispose();
  release();
  await sender.done();
  assert.deepEqual(calls, [
    {
      type: "dialog_response",
      id: "request-a",
      sessionId: "session-a",
      value: "a".repeat(4096),
    },
  ]);
});

test("terminal sanitizer preserves SGR while removing unsafe control sequences", () => {
  assert.equal(
    sanitizeLine("\x1b]52;c;secret\x07\x1b[31mred\x1b[2J\x07"),
    "\x1b[31mred",
  );
});
