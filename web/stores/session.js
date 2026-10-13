import { defineStore } from "pinia";
export const useSessionStore = defineStore("session", {
  state: () => ({
    sessionId: null,
    instanceId: null,
    // 扩展自身版本（「设置 → 关于」展示）：旧后端不下发时为空串。
    extensionVersion: "",
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
    // 当前模型上下文占用：`{ tokens, contextWindow, percent }`（tokens/percent 可为 null）
    // 或 null（读不到）。输入框旁的占比圆环与弹层读它。
    contextUsage: null,
    connection: "connecting",
    // 网关端口配置：`{ port, lanPort, gateway: {id, port, lan} | null }`（设置页「会话 → 网关端口」）。
    // 旧后端不下发时为 null，那一栏只显示「未接入网关」。
    webConfig: null,
    // 正在生成这条消息的实时观测 `{ startedAt, elapsedMs, estimatedTokens }` 或 null
    //（只含正文与思考的生成过程，状态栏的 tok/s 在流式期间读它）。
    liveGeneration: null,
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
