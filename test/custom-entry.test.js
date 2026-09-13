import assert from "node:assert/strict";
import test from "node:test";
import {
  installEntryRendererObserver,
  normalizeCustomEntry,
} from "../extensions/custom-entry.ts";

test("custom entries include the registered TUI renderer text for both disclosure states", () => {
  class Runner {
    getEntryRenderer() {
      return (_entry, options) => ({
        render: () => [
          options.expanded
            ? "\u001b[32m[plugin]\u001b[39m 完整正文"
            : "\u001b[32m[plugin]\u001b[39m 摘要",
        ],
      });
    }
  }
  const renderers = installEntryRendererObserver(Runner);
  new Runner().getEntryRenderer("plugin-status");
  assert.deepEqual(
    normalizeCustomEntry(
      {
        id: "entry-1",
        customType: "plugin-status",
        data: { active: true },
        timestamp: "2026-09-13T10:00:00.000Z",
      },
      "session-a",
      { renderer: renderers.get("plugin-status"), theme: {}, width: 100 },
    ),
    {
      id: "session-a:branch:entry-1",
      role: "customEntry",
      customType: "plugin-status",
      data: { active: true },
      collapsedText: "[plugin] 摘要",
      expandedText: "[plugin] 完整正文",
      timestamp: "2026-09-13T10:00:00.000Z",
    },
  );
});

test("a failing or absent TUI renderer keeps the bounded JSON fallback", () => {
  const entry = { id: "entry-2", customType: "broken", data: { count: 2 } };
  assert.doesNotThrow(() =>
    normalizeCustomEntry(entry, "session-a", {
      renderer: () => {
        throw new Error("renderer failed");
      },
      theme: {},
    }),
  );
  const result = normalizeCustomEntry(entry, "session-a");
  assert.equal(result.collapsedText, undefined);
  assert.deepEqual(result.data, { count: 2 });
});
