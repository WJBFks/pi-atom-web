import { defineStore } from "pinia";
export const useSessionStore = defineStore("session", {
  state: () => ({
    sessionId: null,
    instanceId: null,
    name: "未命名会话",
    cwd: "—",
    model: "—",
    selectedModel: null,
    modelOptions: [],
    thinking: "off",
    thinkingLevels: [],
    busy: false,
    pending: false,
    promptQueue: { revision: 0, count: 0, steering: [], followUp: [] },
    commands: [],
    stats: null,
    connection: "connecting",
    error: "",
  }),
  actions: {
    applySnapshot(snapshot) {
      Object.assign(
        this,
        Object.fromEntries(
          Object.entries(snapshot).filter(
            ([key]) =>
              ![
                "messages",
                "liveMessage",
                "pendingUserMessages",
                "responseWaitStartedAt",
                "tools",
                "toolTimings",
                "thinkingTimings",
                "disclosures",
                "requests",
              ].includes(key),
          ),
        ),
      );
    },
    applyPatch(patch) {
      Object.assign(
        this,
        Object.fromEntries(
          Object.entries(patch).filter(
            ([key]) =>
              ![
                "messages",
                "liveMessage",
                "pendingUserMessages",
                "responseWaitStartedAt",
                "tools",
                "toolTimings",
                "thinkingTimings",
                "disclosures",
                "requests",
              ].includes(key),
          ),
        ),
      );
    },
  },
});
