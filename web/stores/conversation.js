import { shallowRef } from "vue";
import { defineStore } from "pinia";

export const messageId = (message) =>
  String(
    message.id ??
      message.messageId ??
      message.uuid ??
      `${message.role || "message"}:${JSON.stringify(message.content ?? "")}`,
  );
export const contentBlocks = (content) =>
  Array.isArray(content) ? content : [];

// 一条消息里最后一个思考块的下标（-1 表示没有）：只有它在仍在生成时保持展开，
// 下一个思考块一出现，前一个就折叠；整段回话结束时全部折叠。
export function lastThinkingIndex(content) {
  let last = -1;
  contentBlocks(content).forEach((block, index) => {
    if (block?.type === "thinking") last = index;
  });
  return last;
}
export const toolCallId = (call) => call?.id ?? call?.toolCallId;
export const toolResultId = (result) => result?.toolCallId;

// 合并两段历史：老的在前，重复 id 以「新的那一段」为准、但保留原有位置。
// 服务端只发最近若干轮的窗口（会随新轮向前滑动），客户端因此只能做并集，
// 否则窗口滑出一轮就会在对话中间缺一段。
export function mergeHistory(older = [], next = []) {
  const seen = new Map();
  for (const message of older) seen.set(messageId(message), message);
  for (const message of next) seen.set(messageId(message), message);
  return [...seen.values()];
}

export function buildToolContext(
  messages = [],
  runningTools = [],
  timingData = {},
) {
  const calls = new Map(),
    results = new Map();
  for (const message of messages) {
    if (message.role === "toolResult") {
      const id = toolResultId(message);
      if (id != null) results.set(String(id), message);
      continue;
    }
    if (message.role !== "assistant") continue;
    for (const block of contentBlocks(message.content)) {
      if (block?.type !== "toolCall") continue;
      const id = toolCallId(block);
      if (id != null) calls.set(String(id), block);
    }
  }
  return syncToolRuntime(
    { calls, results, running: new Map(), timings: new Map() },
    runningTools,
    timingData,
  );
}

export function syncToolRuntime(context, runningTools = [], timingData = {}) {
  context.running.clear();
  for (const tool of runningTools) {
    const id = toolResultId(tool);
    if (id != null) context.running.set(String(id), tool);
  }
  context.timings.clear();
  for (const [id, timing] of Object.entries(timingData || {}))
    context.timings.set(id, timing);
  return context;
}

function thinkingBlocks(message) {
  if (!message) return [];
  const id = messageId(message);
  return contentBlocks(message.content).flatMap((block, index) =>
    block?.type === "thinking" ? [{ key: `${id}-thinking-${index}`, index }] : [],
  );
}

function thinkingKeys(message) {
  return thinkingBlocks(message).map(({ key }) => key);
}

function migrateThinkingPrefix(state, oldId, nextId) {
  const oldPrefix = `${oldId}-thinking-`;
  let migrated = false;
  for (const collection of [
    state.thinkingOpen,
    state.thinkingTouched,
    state.thinkingTimes,
    state.disclosures,
  ].filter(Boolean)) {
    for (const key of [...collection.keys()]) {
      if (!String(key).startsWith(oldPrefix)) continue;
      const nextKey = `${nextId}${String(key).slice(String(oldId).length)}`;
      migrated = true;
      if (collection instanceof Set) {
        collection.delete(key);
        collection.add(nextKey);
      } else {
        const value = collection.get(key);
        collection.delete(key);
        collection.set(nextKey, value);
      }
    }
  }
  return migrated;
}

export function applyConversationSnapshot(state, snapshot) {
  const next = [],
    ids = new Set();
  let migrated = false;
  for (const incoming of snapshot.messages || []) {
    const id = messageId(incoming);
    ids.add(id);
    const old = state.messageById.get(id);
    const value =
      old && JSON.stringify(old) === JSON.stringify(incoming) ? old : incoming;
    state.messageById.set(id, value);
    next.push(value);
  }
  for (const incoming of snapshot.messages || []) {
    if (
      !incoming.liveId ||
      !incoming.id ||
      String(incoming.liveId) === String(incoming.id)
    )
      continue;
    migrated =
      migrateThinkingPrefix(state, String(incoming.liveId), String(incoming.id)) ||
      migrated;
  }
  for (const id of state.messageById.keys())
    if (!ids.has(id)) state.messageById.delete(id);
  state.messages = next;
  if (Object.hasOwn(snapshot, "pendingUserMessages"))
    state.pendingUserMessages = snapshot.pendingUserMessages || [];
  if (Object.hasOwn(snapshot, "responseWaitStartedAt"))
    state.responseWaitStartedAt = snapshot.responseWaitStartedAt;
  if (Object.hasOwn(snapshot, "liveMessage"))
    state.liveMessage = snapshot.liveMessage;

  const validThinking = new Set(next.flatMap(thinkingKeys));
  if (state.liveMessage)
    for (const key of thinkingKeys(state.liveMessage)) validThinking.add(key);
  for (const collection of [
    state.thinkingOpen,
    state.thinkingTouched,
    state.thinkingTimes,
  ].filter(Boolean)) {
    for (const key of [...collection.keys()])
      if (!validThinking.has(key)) collection.delete(key);
  }
  return migrated;
}

const sharedNow = shallowRef(Date.now());
let clockUsers = 0,
  clockTimer;
export function useConversationClock() {
  const start = () => {
    clockUsers += 1;
    if (clockUsers === 1)
      clockTimer = setInterval(() => {
        sharedNow.value = Date.now();
      }, 100);
  };
  const stop = () => {
    clockUsers = Math.max(0, clockUsers - 1);
    if (!clockUsers) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
  return { now: sharedNow, start, stop };
}

export const useConversationStore = defineStore("conversation", {
  state: () => ({
    messages: [],
    messageById: new Map(),
    liveMessage: null,
    pendingUserMessages: [],
    responseWaitStartedAt: null,
    tools: [],
    toolTimings: {},
    historyTools: buildToolContext(),
    thinkingOpen: new Map(),
    thinkingTouched: new Set(),
    thinkingTimes: new Map(),
    disclosures: new Map(),
    revision: 0,
    // 更早的历史是否已经全部取回；加载时是否把已加载的中间过程全部折叠。
    historyComplete: false,
    collapseLoaded: true,
    prependedCount: 0,
  }),
  actions: {
    addOptimisticUserMessage(content) {
      const message = {
        id: `browser-pending:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        role: "user",
        content,
      };
      this.pendingUserMessages = [...this.pendingUserMessages, message];
      this.revision += 1;
      return message.id;
    },
    removeOptimisticUserMessage(id) {
      const next = this.pendingUserMessages.filter(
        (message) => message.id !== id,
      );
      if (next.length === this.pendingUserMessages.length) return;
      this.pendingUserMessages = next;
      this.revision += 1;
    },
    applySnapshot(snapshot) {
      const previousLive = this.liveMessage;
      const nextLive = snapshot.liveMessage ?? null;
      this.finishThinking(previousLive, nextLive);
      applyConversationSnapshot(this, snapshot);
      this.tools = snapshot.tools || [];
      this.toolTimings = snapshot.toolTimings || {};
      this.thinkingTimes = new Map(Object.entries(snapshot.thinkingTimings || {}));
      this.disclosures = new Map(Object.entries(snapshot.disclosures || {}));
      this.historyTools = buildToolContext(
        this.messages,
        this.tools,
        this.toolTimings,
      );
      this.historyComplete = snapshot.historyComplete !== false;
      // 首次加载：已加载的中间过程全部折叠（正在生成的那一轮由 busy 决定）。
      this.collapseLoaded = true;
      this.prependedCount = 0;
      this.startThinking(nextLive);
      this.revision += 1;
    },
    applyPatch(patch) {
      const previousLive = this.liveMessage;
      const nextLive = Object.hasOwn(patch, "liveMessage")
        ? patch.liveMessage
        : previousLive;
      this.finishThinking(previousLive, nextLive);
      let migrated = false;
      if ("messages" in patch)
        migrated = applyConversationSnapshot(this, {
          // 并集：窗口滑动不会丢已加载的轮次
          messages: mergeHistory(this.messages, patch.messages),
          liveMessage: nextLive,
        });
      else if ("liveMessage" in patch) this.liveMessage = nextLive;
      if ("prependMessages" in patch && patch.prependMessages?.length) {
        applyConversationSnapshot(this, {
          messages: mergeHistory(patch.prependMessages, this.messages),
          liveMessage: nextLive,
        });
        this.prependedCount += 1;
      }
      if ("historyComplete" in patch)
        this.historyComplete = patch.historyComplete !== false;
      // 新的生成开始时，加载时的「全部折叠」不再适用
      if (patch.busy === true || patch.liveMessage) this.collapseLoaded = false;
      if ("pendingUserMessages" in patch)
        this.pendingUserMessages = patch.pendingUserMessages || [];
      if ("responseWaitStartedAt" in patch)
        this.responseWaitStartedAt = patch.responseWaitStartedAt;
      if ("tools" in patch) this.tools = patch.tools || [];
      if ("toolTimings" in patch) this.toolTimings = patch.toolTimings || {};
      if ("thinkingTimings" in patch)
        this.thinkingTimes = new Map(Object.entries(patch.thinkingTimings || {}));
      if ("disclosures" in patch)
        this.disclosures = new Map(Object.entries(patch.disclosures || {}));
      if ("messages" in patch || "prependMessages" in patch)
        this.historyTools = buildToolContext(
          this.messages,
          this.tools,
          this.toolTimings,
        );
      else if ("tools" in patch || "toolTimings" in patch)
        syncToolRuntime(this.historyTools, this.tools, this.toolTimings);
      this.startThinking(nextLive);
      if (migrated) this.persistUiState?.();
      this.revision += 1;
    },
    setThinking(key, open) {
      this.thinkingTouched.add(String(key));
      this.thinkingOpen.set(String(key), Boolean(open));
      this.setDisclosure(key, open);
    },
    setDisclosure(key, open) {
      this.disclosures.set(String(key), Boolean(open));
      this.persistUiState?.();
    },
    disclosure(key, fallback = false) {
      return this.disclosures.has(String(key))
        ? Boolean(this.disclosures.get(String(key)))
        : fallback;
    },
    // 客户端当前最老一条的 id，作为 more_history 的游标。
    oldestMessageId() {
      const first = this.messages?.[0];
      return first ? String(messageId(first)) : null;
    },
    configurePersistence(handler) {
      this.persistUiState = () =>
        handler({
          thinkingTimings: Object.fromEntries(this.thinkingTimes),
          disclosures: Object.fromEntries(this.disclosures),
        });
    },
    thinkingTiming(key) {
      return this.thinkingTimes.get(String(key));
    },
    startThinking(message) {
      // 只有消息末尾的思考块仍在生成；同一条消息里已经被后续内容块接上的思考不再计时。
      const lastIndex = contentBlocks(message?.content).length - 1;
      for (const { key, index } of thinkingBlocks(message))
        if (index === lastIndex && !this.thinkingTimes.has(key))
          this.thinkingTimes.set(key, { startedAt: Date.now() });
    },
    finishThinking(previous, current) {
      const now = Date.now();
      if (previous && (!current || messageId(previous) !== messageId(current)))
        this.finalizeThinking(thinkingKeys(previous), now);
      this.finishStreamedThinking(current, now);
    },
    // 同一轮里思考后面一旦出现正文或工具调用块，思考即已结束，立刻结算，
    // 不再把后续输出的时间累计进思考耗时。
    finishStreamedThinking(message, now = Date.now()) {
      const lastIndex = contentBlocks(message?.content).length - 1;
      this.finalizeThinking(
        thinkingBlocks(message)
          .filter(({ index }) => index < lastIndex)
          .map(({ key }) => key),
        now,
      );
    },
    finalizeThinking(keys, now = Date.now()) {
      let changed = false;
      for (const key of keys) {
        const timing = this.thinkingTimes.get(key);
        if (!timing || timing.durationMs != null) continue;
        this.thinkingTimes.set(key, {
          ...timing,
          durationMs: Math.max(0, now - timing.startedAt),
        });
        changed = true;
      }
      if (changed) this.persistUiState?.();
    },
  },
});
