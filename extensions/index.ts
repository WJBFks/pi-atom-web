import { stripVTControlCharacters } from "node:util";
import { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createPackageCompatibilityRegistry } from "./packages/registry.ts";
import { bridgeDialogs } from "./dialogs.ts";
import { startServer } from "./server.ts";
import { normalizeRunningTool } from "./tool-events.ts";
import { statusNoteFor } from "./status-note.ts";
import {
  installEntryRendererObserver,
  normalizeCustomEntry,
  onEntryRendererObserved,
} from "./custom-entry.ts";
import { createSessionStateStore } from "./session-state.ts";
import {
  installPromptQueueRuntime,
  promptQueueSnapshot,
} from "./prompt-queue.ts";

const RELOAD_HANDOFF = Symbol.for("pi-atom-web.reload-handoff");
const promptQueues = installPromptQueueRuntime(AgentSession);
import {
  HISTORY_PAGE_TURNS,
  HISTORY_TURNS,
  historyCutIndex,
  olderHistory,
  windowedHistory as calculateWindowedHistory,
} from "./history-window.ts";

const INTERNAL_RELOAD_COMMAND = "pi-atom-web-reload";
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return (level !== "xhigh" && level !== "max") || mapped !== undefined;
  });
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    child.unref();
    const timer = setTimeout(() => resolve(true), 1500);
    timer.unref();
  });
}

export default function atomWeb(pi) {
  const entryRenderers = installEntryRendererObserver(ExtensionRunner);
  const instanceId = randomUUID();
  let context,
    server,
    starting,
    liveMessage = null,
    liveRunId = null,
    publishTimer,
    reloadFallbackTimer,
    pendingPatch,
    pendingSessionId,
    lastSessionId,
    fieldSignatures = new Map();
  let historyDirty = false,
    statsDirty = false;
  const pendingLiveLinks = new Map(),
    completedLiveIds = new Map();
  const pendingUserRecords = [];
  let responseWaitStartedAt = null;
  let responseWaitOwnerId = null;
  const runningTools = new Map();
  const completedToolTimings = new Map();
  const completedThinkingTimings = new Map();
  const disclosures = new Map();
  let stateStore;
  const packageCompatibilities = createPackageCompatibilityRegistry(pi);
  const displayRecords = [];
  function persistState() {
    stateStore?.replace({
      schemaVersion: 1,
      toolTimings: Object.fromEntries(completedToolTimings),
      thinkingTimings: Object.fromEntries(completedThinkingTimings),
      disclosures: Object.fromEntries(disclosures),
      displayRecords,
    });
  }
  async function activateState(ctx, preserveDisplayRecords = false) {
    await stateStore?.close();
    const sessionId = ctx.sessionManager.getSessionId();
    stateStore = createSessionStateStore({ cwd: ctx.cwd, sessionId });
    const saved = await stateStore.load();
    const capturedDisplayRecords = preserveDisplayRecords
      ? displayRecords.filter((record) => record.sessionId === sessionId)
      : [];
    completedToolTimings.clear();
    for (const entry of Object.entries(saved.toolTimings)) completedToolTimings.set(...entry);
    completedThinkingTimings.clear();
    for (const entry of Object.entries(saved.thinkingTimings)) completedThinkingTimings.set(...entry);
    disclosures.clear();
    for (const entry of Object.entries(saved.disclosures)) disclosures.set(...entry);
    displayRecords.length = 0;
    displayRecords.push(...saved.displayRecords, ...capturedDisplayRecords);
    if (capturedDisplayRecords.length) persistState();
  }
  let notificationBridge, dialogs;
  let stopPromptQueueListener;
  function currentPromptQueue(ctx = context) {
    try {
      return promptQueues.snapshot(ctx?.sessionManager);
    } catch {
      return promptQueueSnapshot();
    }
  }
  function bindPromptQueue(ctx) {
    stopPromptQueueListener?.();
    stopPromptQueueListener = undefined;
    try {
      stopPromptQueueListener = promptQueues.listen(
        ctx.sessionManager,
        (promptQueue) =>
          publish(ctx, { promptQueue, pending: promptQueue.count > 0 }),
      );
    } catch {
      // Older or replaced Pi runtimes may not expose AgentSession internals.
    }
  }
  async function submitPrompt(content, options) {
    if (promptQueues.has(context.sessionManager))
      return promptQueues.submit(context.sessionManager, content, options);
    // 旧 Pi 或测试宿主没有 AgentSession 观察入口时保留正式扩展 API 回退。
    pi.sendUserMessage(content, {
      deliverAs: options.mode,
      ...(options.expandPromptTemplates === undefined
        ? {}
        : { expandPromptTemplates: options.expandPromptTemplates }),
    });
  }
  const stopRendererObserver = onEntryRendererObserved(ExtensionRunner, () => {
    if (context && server) publish(context, {}, { history: true });
  });
  function recordDisplay(role, text, level, detail) {
    const branch = context.sessionManager.getBranch();
    displayRecords.push({
      id: `${context.sessionManager.getSessionId()}:display:${randomUUID()}`,
      sessionId: context.sessionManager.getSessionId(),
      anchor: branch.at(-1)?.id ?? null,
      message: {
        role,
        content: stripVTControlCharacters(String(text)),
        level,
        ...(detail ? { detail: String(detail).slice(0, 4096) } : {}),
      },
    });
    if (displayRecords.length > 500) displayRecords.shift();
    persistState();
    publish(context, {}, { history: true });
  }
  // 已记录过中止提示的 branch 末尾 entry id —— 同一轮不要重复插红条。
  let interruptedEntryId = null;
  // 待插入的「状态提示」：切换模型 / 思考级别时暂存，下一次发送 prompt 前插入，
  // 说明这一轮是在什么配置下跑的（用户看到的就是「先有状态提示，再有这轮对话」）。
  //
  // **只保留最后一次**：用户连续切了好几次再输入，中间过程的切换没有意义，
  // 只应在输入前提示最终那一次（模型已切换为\`最后值\`）。
  let pendingStatusNote = "";

  /**
   * 模型被终止（用户中断 / 模型报错）时补一条系统记录，Web 端渲染成红色横线。
   *
   * 判据来自宿主：一轮结束时最后一条 assistant 消息的 stopReason 为
   * "aborted"（用户中断）或 "error"（模型/网络报错），errorMessage 为详情。
   * 正常结束（stop / toolUse）不记录，所以不会误报。
   */
  function recordInterruption(branch) {
    const last = branch.at(-1);
    if (last?.type !== "message" || last.message?.role !== "assistant") return;
    const reason = last.message.stopReason;
    if (reason !== "aborted" && reason !== "error") return;
    // 同一条 entry 只记一次（agent_end / agent_settled 可能都触发）。
    // 带上会话 id：换会话后 entry id 不保证唯一，不带会把新会话的误判成已记录。
    const marker = `${context.sessionManager.getSessionId()}:${last.id}`;
    if (interruptedEntryId === marker) return;
    interruptedEntryId = marker;
    const detail = stripVTControlCharacters(
      String(last.message.errorMessage || "").replace(/\s+/g, " ").trim(),
    );
    // 中止原因：用户中断 / 模型或网络报错，**统一显示为「已中断」**
    // （不再区分「模型出错」），能拿到具体原因时显示成「已中断：原因」。
    recordDisplay(
      "interrupted",
      detail ? `已中断：${detail}` : "已中断",
      reason,
      detail,
    );
  }

  // 工具被中止时宿主写的固定措辞（bash 被 Esc 打断等）。
  const OPERATION_ABORTED = /operation aborted|aborted/i;

  /** 安全读一个字段：异常 getter / 循环引用都不该让事件处理抛错。 */
  function safeField(source, key) {
    try {
      return source?.[key];
    } catch {
      return undefined;
    }
  }

  /** 把 toolResult 的 result 归一成纯文本，供上面那句措辞匹配。 */
  function toolResultText(result) {
    const value = safeField(result, "output") ?? safeField(result, "content") ?? result;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((block) =>
          typeof block === "string" ? block : String(safeField(block, "text") ?? ""),
        )
        .join("\n");
    }
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }

  // 同一个工具调用只记一条，避免 update/end 重复插入。
  const toolAbortNotes = new Set();

  /**
   * 工具本身被中止（用户按 Esc、或进程被杀）时，结果里是
   * `isError: true` 且文本为 `Operation aborted`（宿主的固定措辞）。
   * 这种情况补一条红色的「操作已中断」状态提示；hover 双语说明原文。
   */
  function recordToolAbort(event) {
    const id = String(safeField(event, "toolCallId") || "");
    if (!id || toolAbortNotes.has(id)) return;
    const failed = safeField(event, "isError") === true;
    if (!failed) return;
    const text = toolResultText(safeField(event, "result"));
    if (!OPERATION_ABORTED.test(text)) return;
    toolAbortNotes.add(id);
    if (toolAbortNotes.size > 500)
      toolAbortNotes.delete(toolAbortNotes.values().next().value);
    // 与模型侧统一：显示「已中断」，并把工具结果里的原文作为原因带上。
    const detail = text.trim().replace(/\s+/g, " ");
    recordDisplay(
      "interrupted",
      detail ? `已中断：${detail}` : "已中断",
      "tool-aborted",
      detail,
    );
  }

  /**
   * 记录「状态提示」：模型 / 思考级别的变更，**统一格式**——
   * 切换模型与切换思考级别都显示「模型已切换为\`模型id · 思考级别\`」，
   * 不单独为思考级别出提示。
   *
   * 用宿主事件驱动而不是 Web 动作 —— TUI 里切换同样要出现在网页里。
   *
   * **总是覆盖为最新值**：连续切好几次再输入，只提示最终那一次。
   * 不要用「值没变就不记」来做去重 —— 那样会漏掉 A→B→A 场景里最后一次
   * A 的提示（中间换过、最后又换回来，最终值可能与最早相同）。
   * 宿主事件对一次切换只发一次，重复覆盖同值是无害的。
   */
  function recordStatusChange(ctx) {
    const note = statusNoteFor(
      ctx.model ? String(ctx.model.id) : "",
      String(ctx.thinkingLevel || "off"),
    );
    if (note) pendingStatusNote = note;
  }

  function detachNotifications() {
    const closing = dialogs;
    dialogs = undefined;
    closing?.close();
    if (!notificationBridge) return;
    const { ui, original, wrapper } = notificationBridge;
    if (ui.notify === wrapper) ui.notify = original;
    notificationBridge = undefined;
  }
  function attachNotifications() {
    const ui = context.ui;
    if (notificationBridge?.ui === ui) return;
    detachNotifications();
    const original = ui.notify;
    const wrapper = function (text, level) {
      const result = original.call(this, text, level);
      recordDisplay("notification", text, level);
      return result;
    };
    ui.notify = wrapper;
    notificationBridge = { ui, original, wrapper };
    dialogs = bridgeDialogs(
      ui,
      () => context.sessionManager.getSessionId(),
      () => publish(context, { requests: dialogs?.list() || [] }),
      { takeCustom: (factory) => packageCompatibilities.takeCustom(factory) },
    );
  }
  // Connection URLs contain credentials and must never enter the mirrored transcript.
  function notifyLocal(ctx, text, level) {
    const notify =
      notificationBridge?.ui === ctx.ui
        ? notificationBridge.original
        : ctx.ui.notify;
    notify.call(ctx.ui, text, level);
  }
  function displayMessages() {
    const records = displayRecords.filter(
      (r) => r.sessionId === context.sessionManager.getSessionId(),
    );
    const namespace = context.sessionManager.getSessionId();
    const branch = context.sessionManager.getBranch();
    const claimedUserEntries = new Set();
    const reconciledRecordIds = new Set();
    for (const record of pendingUserRecords) {
      if (record.sessionId !== namespace) continue;
      const anchor =
        record.anchor == null
          ? -1
          : branch.findIndex((entry) => entry.id === record.anchor);
      if (record.anchor != null && anchor < 0) continue;
      const expectedContent = record.acceptedContent ?? record.message.content;
      const entry = branch
        .slice(anchor + 1)
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            !claimedUserEntries.has(entry.id) &&
            userMessageText(entry.message.content) ===
              userMessageText(expectedContent),
        );
      if (entry) {
        claimedUserEntries.add(entry.id);
        reconciledRecordIds.add(record.message.id);
      }
    }
    if (reconciledRecordIds.size) {
      for (let index = pendingUserRecords.length - 1; index >= 0; index--)
        if (reconciledRecordIds.has(pendingUserRecords[index].message.id))
          removePendingUserRecord(pendingUserRecords[index]);
    }
    const branchIds = new Set(
      branch.map((entry) => `${namespace}:branch:${entry.id}`),
    );
    for (const id of completedLiveIds.keys())
      if (!branchIds.has(id)) completedLiveIds.delete(id);
    for (const [liveId, link] of pendingLiveLinks) {
      if (link.sessionId !== namespace) {
        pendingLiveLinks.delete(liveId);
        continue;
      }
      const anchor =
        link.afterEntryId == null
          ? -1
          : branch.findIndex((entry) => entry.id === link.afterEntryId);
      if (link.afterEntryId != null && anchor < 0) {
        pendingLiveLinks.delete(liveId);
        continue;
      }
      // Pi appends the completed message after its extension callback. Only new
      // entries after that callback's branch anchor can belong to this live run.
      const entry = branch
        .slice(anchor + 1)
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            !completedLiveIds.has(`${namespace}:branch:${entry.id}`) &&
            (entry.message === link.message ||
              JSON.stringify(entry.message.content) === link.content),
        );
      if (entry) {
        completedLiveIds.set(`${namespace}:branch:${entry.id}`, liveId);
        pendingLiveLinks.delete(liveId);
      }
    }
    const withId = (message, id) => ({
      ...message,
      id,
      ...(completedLiveIds.has(id) ? { liveId: completedLiveIds.get(id) } : {}),
    });
    const messages = records
      .filter((r) => r.anchor === null)
      .map((r) => withId(r.message, r.id));
    for (const entry of branch) {
      if (entry.type === "message")
        messages.push(withId(entry.message, `${namespace}:branch:${entry.id}`));
      else if (entry.type === "custom")
        messages.push(
          normalizeCustomEntry(entry, namespace, {
            renderer: entryRenderers.get(entry.customType),
            theme: context.ui?.theme,
            width: 100,
          }),
        );
      messages.push(
        ...records
          .filter((r) => r.anchor === entry.id)
          .map((r) => withId(r.message, r.id)),
      );
    }
    return messages;
  }
  function pendingUserMessages() {
    const sessionId = context.sessionManager.getSessionId();
    return pendingUserRecords
      .filter((record) => record.sessionId === sessionId && record.visible)
      .map((record) => record.message);
  }
  function removePendingUserRecord(record) {
    const index = pendingUserRecords.indexOf(record);
    if (index >= 0) pendingUserRecords.splice(index, 1);
  }
  function userMessageText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
  }
  function trackSubmittedPrompt(content, startsImmediately, visible = true) {
    const sessionId = context.sessionManager.getSessionId();
    const record = {
      sessionId,
      anchor: context.sessionManager.getBranch().at(-1)?.id ?? null,
      message: {
        id: `${sessionId}:pending-user:${randomUUID()}`,
        role: "user",
        content,
      },
      visible,
    };
    pendingUserRecords.push(record);
    if (startsImmediately) {
      responseWaitOwnerId = record.message.id;
      responseWaitStartedAt = Date.now();
    }
    publish(context, {
      pendingUserMessages: pendingUserMessages(),
      responseWaitStartedAt,
    });
    return record;
  }
  function commands() {
    const available = pi
      .getCommands()
      .filter((command) => command.name !== INTERNAL_RELOAD_COMMAND)
      .map(({ name, description, source }) => ({ name, description, source }));
    if (!available.some((command) => command.name === "reload")) {
      available.unshift({
        name: "reload",
        description: "重新加载 TUI 扩展并恢复 Web UI",
        source: "builtin",
      });
    }
    const webCommands = [
      { name: "model", description: "打开 Web 模型选择器", source: "web" },
      { name: "session", description: "打开 Web 会话信息", source: "web" },
      { name: "copy", description: "复制最后一条助手文本", source: "web" },
      {
        name: "name",
        description: "设置会话名称：/name <名称>",
        source: "web",
      },
      {
        name: "compact",
        description: "压缩当前上下文：/compact [指令]",
        source: "web",
      },
    ];
    for (const command of webCommands)
      if (!available.some((item) => item.name === command.name))
        available.push(command);
    return available;
  }
  function sessionStats() {
    const branch = context.sessionManager.getBranch();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
    };
    let rounds = 0,
      startedAt,
      activeAt;
    for (const entry of branch) {
      const message = entry.type === "message" ? entry.message : null;
      if (message?.role === "user") rounds++;
      const itemUsage = message?.usage ?? entry.usage;
      if (itemUsage) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"])
          usage[key] += Number(itemUsage[key]) || 0;
        usage.cost += Number(itemUsage.cost?.total) || 0;
      }
      const rawTimestamp = entry.timestamp ?? message?.timestamp;
      const timestamp =
        typeof rawTimestamp === "number"
          ? rawTimestamp
          : Date.parse(rawTimestamp);
      if (Number.isFinite(timestamp) && (!startedAt || timestamp < startedAt))
        startedAt = timestamp;
      if (Number.isFinite(timestamp) && (!activeAt || timestamp > activeAt))
        activeAt = timestamp;
    }
    usage.total =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    return {
      rounds,
      events: branch.length,
      startedAt: startedAt || Date.now(),
      activeAt: activeAt || startedAt || Date.now(),
      usage,
      cacheHit: prompt ? usage.cacheRead / prompt : 0,
      workspace: {
        name: basename(context.cwd) || context.cwd,
        id: context.sessionManager.getSessionId(),
        path: context.cwd,
      },
      sessionFile:
        typeof context.sessionManager.getSessionFile === "function"
          ? context.sessionManager.getSessionFile() || "内存会话"
          : "内存会话",
    };
  }
  function modelOptions() {
    const scoped = context.scopedModels?.length
      ? context.scopedModels.map((item) => item.model)
      : context.modelRegistry?.getAvailable?.() || [];
    return scoped.map((model) => ({
      provider: model.provider,
      providerName:
        context.modelRegistry?.getProviderDisplayName?.(model.provider) ||
        model.provider,
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      thinkingLevels: supportedThinkingLevels(model),
    }));
  }
  // 首屏只带最近 HISTORY_TURNS 轮：更早的由客户端用 more_history 按游标向前懒加载。
  function windowedMessages() {
    return calculateWindowedHistory(displayMessages(), HISTORY_TURNS);
  }
  function snapshot() {
    const value = {
      schemaVersion: 1,
      sessionId: context.sessionManager.getSessionId(),
      instanceId,
      name: pi.getSessionName() || "未命名会话",
      cwd: context.cwd,
      model: context.model
        ? `${context.model.provider} / ${context.model.id}`
        : "未选择模型",
      selectedModel: context.model
        ? { provider: context.model.provider, id: context.model.id }
        : null,
      modelOptions: modelOptions(),
      thinkingLevels: supportedThinkingLevels(context.model),
      thinking: context.thinkingLevel || "off",
      busy: !context.isIdle(),
      pending: context.hasPendingMessages(),
      promptQueue: currentPromptQueue(),
      commands: commands(),
      stats: sessionStats(),
      ...windowedMessages(),
      pendingUserMessages: pendingUserMessages(),
      responseWaitStartedAt,
      requests: dialogs?.list() || [],
      liveMessage,
      tools: [...runningTools.values()],
      toolTimings: Object.fromEntries(completedToolTimings),
      thinkingTimings: Object.fromEntries(completedThinkingTimings),
      disclosures: Object.fromEntries(disclosures),
    };
    // A second client's snapshot must not consume changes queued for existing clients.
    lastSessionId ??= value.sessionId;
    if (!fieldSignatures.size)
      fieldSignatures = new Map(
        Object.entries(value).map(([key, field]) => [
          key,
          JSON.stringify(field),
        ]),
      );
    return value;
  }
  function publish(ctx, patch = {}, refresh = {}) {
    context = ctx;
    if (server) attachNotifications();
    // 历史字段在出口统一裁剪成窗口：流式期间不再重复发送整段会话。
    if (Array.isArray(patch.messages)) {
      const window = calculateWindowedHistory(patch.messages, HISTORY_TURNS);
      patch = { ...patch, ...window };
    }
    const sessionChanged =
      lastSessionId !== context.sessionManager.getSessionId();
    if (sessionChanged) {
      fieldSignatures.clear();
      pendingPatch = undefined;
      historyDirty = false;
      statsDirty = false;
    }
    lastSessionId = context.sessionManager.getSessionId();
    historyDirty ||= Boolean(refresh.history);
    statsDirty ||= Boolean(refresh.stats);
    const changes = {};
    for (const [key, value] of Object.entries(patch)) {
      const signature = JSON.stringify(value);
      if (fieldSignatures.get(key) === signature) continue;
      fieldSignatures.set(key, signature);
      changes[key] = value;
    }
    if (
      !Object.keys(changes).length &&
      !sessionChanged &&
      !historyDirty &&
      !statsDirty
    )
      return;
    pendingPatch = { ...pendingPatch, ...changes };
    pendingSessionId = context.sessionManager.getSessionId();
    if (!publishTimer)
      publishTimer = setTimeout(() => {
        const changes = pendingPatch || {};
        const sessionId = pendingSessionId;
        publishTimer = undefined;
        pendingPatch = undefined;
        pendingSessionId = undefined;
        // Read persisted history only after Pi has returned from the event callback.
        const refreshed = {};
        if (historyDirty) {
          Object.assign(refreshed, windowedMessages());
          refreshed.pendingUserMessages = pendingUserMessages();
        }
        if (statsDirty) refreshed.stats = sessionStats();
        historyDirty = false;
        statsDirty = false;
        for (const [key, value] of Object.entries(refreshed)) {
          const signature = JSON.stringify(value);
          if (fieldSignatures.get(key) !== signature) {
            fieldSignatures.set(key, signature);
            changes[key] = value;
          }
        }
        server?.publish(changes, sessionId);
      }, 32);
  }
  async function action(input) {
    if (!input || input.sessionId !== context.sessionManager.getSessionId())
      throw new Error("TUI 已切换会话，请等待页面同步后重试");
    if (input.type === "dialog_response") {
      if (!dialogs) throw new Error("插件请求已结束");
      dialogs.respond(input.id, input.value, input.cancel === true);
      return;
    }
    if (input.type === "queue_add") {
      const promptQueue = await promptQueues.add(
        context.sessionManager,
        input.kind,
        input.text,
      );
      return { promptQueue };
    }
    if (input.type === "queue_remove") {
      return promptQueues.remove(context.sessionManager, input);
    }
    if (input.type === "queue_update_item") {
      return promptQueues.update(context.sessionManager, input);
    }
    if (input.type === "save_ui_state") {
      completedThinkingTimings.clear();
      for (const entry of Object.entries(input.thinkingTimings || {}))
        completedThinkingTimings.set(...entry);
      disclosures.clear();
      for (const entry of Object.entries(input.disclosures || {})) disclosures.set(...entry);
      persistState();
      publish(context, {
        thinkingTimings: Object.fromEntries(completedThinkingTimings),
        disclosures: Object.fromEntries(disclosures),
      });
      return;
    }
    if (input.type === "more_history") {
      // 游标是客户端当前最老一条的 id：向前再取一页，用 prependMessages 追加，
      // 客户端只做前置拼接，不会影响已渲染内容与滚动位置。
      const all = displayMessages();
      const index = all.findIndex(
        (message) => String(message.id) === String(input.cursor),
      );
      if (index <= 0) {
        publish(context, { historyComplete: true });
        return { queued: true, count: 0 };
      }
      const { messages: chunk, start } = olderHistory(
        all,
        index,
        HISTORY_PAGE_TURNS,
      );
      publish(context, {
        prependMessages: chunk,
        historyComplete: start === 0,
      });
      return { queued: true, count: chunk.length };
    }
    if (input.type === "abort") {
      context.abort();
      responseWaitOwnerId = null;
      responseWaitStartedAt = null;
      publish(context, { responseWaitStartedAt });
      return;
    }
    if (input.type === "select_model") {
      if (!context.isIdle()) throw new Error("请等待当前响应完成后再切换模型");
      const model = (
        context.scopedModels?.length
          ? context.scopedModels.map((item) => item.model)
          : context.modelRegistry.getAvailable()
      ).find(
        (item) => item.provider === input.provider && item.id === input.modelId,
      );
      if (!model) throw new Error("模型不可用，请刷新后重试");
      if (!(await pi.setModel(model))) throw new Error("模型认证不可用");
      publish(context, {
        model: `${model.provider} / ${model.id}`,
        selectedModel: { provider: model.provider, id: model.id },
        thinkingLevels: supportedThinkingLevels(model),
        modelOptions: modelOptions(),
      });
      return;
    }
    if (input.type === "select_thinking") {
      if (!context.isIdle())
        throw new Error("请等待当前响应完成后再切换思考级别");
      const levels = supportedThinkingLevels(context.model);
      if (!levels.includes(input.level))
        throw new Error("当前模型不支持该思考级别");
      pi.setThinkingLevel(input.level);
      publish(context, { thinking: input.level });
      return;
    }
    if (input.type !== "send" || typeof input.text !== "string")
      throw new Error("请输入消息");
    if (!["followUp", "steer"].includes(input.mode))
      throw new Error("无效的发送方式");
    const text = input.text.trim();
    const images = (input.images || []).map(({ data, mimeType }) => ({
      type: "image",
      data,
      mimeType,
    }));
    if (!text && !images.length) throw new Error("请输入消息或添加图片");
    // 这一轮开始前把**最后一次**的状态提示落到会话里（顺序：状态提示 → 用户消息 → 回复）
    if (pendingStatusNote) {
      recordDisplay("status", pendingStatusNote);
      pendingStatusNote = "";
    }
    const content = images.length
      ? [...(text ? [{ type: "text", text }] : []), ...images]
      : text;
    if (!images.length && text.startsWith("/")) {
      const name = text.slice(1).split(/\s/, 1)[0];
      const command = commands().find((command) => command.name === name);
      if (!command) {
        throw new Error("未找到可执行命令；内置终端命令请在 TUI 中使用");
      }
      if (name === "reload") {
        if (text !== "/reload") throw new Error("用法：/reload");
        if (!context.isIdle()) throw new Error("请等待当前响应完成后再重载");
        globalThis[RELOAD_HANDOFF] = server?.connection;
        clearTimeout(reloadFallbackTimer);
        reloadFallbackTimer = setTimeout(() => {
          if (globalThis[RELOAD_HANDOFF] === server?.connection)
            delete globalThis[RELOAD_HANDOFF];
        }, 5000);
        reloadFallbackTimer.unref();
        pi.sendUserMessage(`/${INTERNAL_RELOAD_COMMAND}`, {
          expandPromptTemplates: true,
        });
        return { reloading: true };
      }
      const args = text.slice(name.length + 1).trim();
      if (name === "name") {
        if (!args) throw new Error("用法：/name <名称>");
        pi.setSessionName(args);
        recordDisplay("command", text);
        publish(context, { name: args });
        return;
      }
      if (name === "compact") {
        if (!context.isIdle())
          throw new Error("请等待当前响应完成后再压缩上下文");
        recordDisplay("command", text);
        context.compact({
          ...(args ? { customInstructions: args } : {}),
          onError: (error) =>
            context.ui.notify(`上下文压缩失败：${error.message}`, "error"),
        });
        publish(context, {
          busy: !context.isIdle(),
          pending: context.hasPendingMessages(),
        });
        return;
      }
      if (["model", "session", "copy"].includes(name))
        throw new Error(`/${name} 需要通过 Web 页面执行`);
      recordDisplay("command", text);
      const startsModelTurn =
        command.source === "prompt" ||
        command.source === "skill" ||
        String(command.source).startsWith("skill:");
      const startsImmediately = startsModelTurn && context.isIdle();
      const record = startsModelTurn
        ? trackSubmittedPrompt(text, startsImmediately, false)
        : null;
      try {
        await submitPrompt(text, {
          mode: input.mode,
          expandPromptTemplates: true,
          onError: (error) =>
            context.ui.notify(`消息执行失败：${error.message}`, "error"),
        });
      } catch (error) {
        if (record) {
          const index = pendingUserRecords.indexOf(record);
          if (index >= 0) removePendingUserRecord(record);
          if (responseWaitOwnerId === record.message.id) {
            responseWaitOwnerId = null;
            responseWaitStartedAt = null;
          }
          publish(context, {
            pendingUserMessages: pendingUserMessages(),
            responseWaitStartedAt,
          });
        }
        throw error;
      }
      return { delivery: startsImmediately ? "started" : "queued" };
    } else {
      const startsImmediately = context.isIdle();
      const record = trackSubmittedPrompt(
        content,
        startsImmediately,
        startsImmediately,
      );
      try {
        await submitPrompt(content, {
          mode: input.mode,
          onError: (error) =>
            context.ui.notify(`消息执行失败：${error.message}`, "error"),
        });
      } catch (error) {
        const index = pendingUserRecords.indexOf(record);
        if (index >= 0) removePendingUserRecord(record);
        if (responseWaitOwnerId === record.message.id) {
          responseWaitOwnerId = null;
          responseWaitStartedAt = null;
        }
        publish(context, {
          pendingUserMessages: pendingUserMessages(),
          responseWaitStartedAt,
        });
        throw error;
      }
      return { delivery: startsImmediately ? "started" : "queued" };
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    bindPromptQueue(ctx);
    const connection = globalThis[RELOAD_HANDOFF];
    // Reload peers may notify while project state and the replacement server load.
    // Install the shared UI wrapper before the first await and merge those records
    // into the persisted state once it becomes available.
    if (connection) attachNotifications();
    liveMessage = null;
    liveRunId = null;
    pendingLiveLinks.clear();
    completedLiveIds.clear();
    runningTools.clear();
    await activateState(ctx, Boolean(connection));
    pendingUserRecords.length = 0;
    responseWaitOwnerId = null;
    responseWaitStartedAt = null;
    publish(
      ctx,
      {
        liveMessage,
        tools: [],
        toolTimings: Object.fromEntries(completedToolTimings),
        thinkingTimings: Object.fromEntries(completedThinkingTimings),
        disclosures: Object.fromEntries(disclosures),
        pendingUserMessages: [],
        responseWaitStartedAt,
      },
      { history: true, stats: true },
    );
    if (!connection) return;
    delete globalThis[RELOAD_HANDOFF];
    try {
      starting = startServer({ snapshot, action, connection }).then((value) => {
        server = value;
      });
      await starting;
      attachNotifications();
      ctx.ui.notify("pi-atom-web 已随 /reload 恢复", "info");
    } catch (error) {
      ctx.ui.notify(`Web UI 恢复失败：${error.message}`, "error");
    } finally {
      starting = undefined;
    }
  });
  for (const name of [
    "session_switch",
    "session_fork",
    "session_tree",
    "session_compact",
  ]) {
    pi.on(name, async (_event, ctx) => {
      context = ctx;
      bindPromptQueue(ctx);
      liveMessage = null;
      liveRunId = null;
      pendingLiveLinks.clear();
      runningTools.clear();
      await activateState(ctx);
      pendingUserRecords.length = 0;
      responseWaitOwnerId = null;
      responseWaitStartedAt = null;
      publish(
        ctx,
        {
          liveMessage,
          tools: [],
          toolTimings: Object.fromEntries(completedToolTimings),
          thinkingTimings: Object.fromEntries(completedThinkingTimings),
          disclosures: Object.fromEntries(disclosures),
          pendingUserMessages: [],
          responseWaitStartedAt,
        },
        { history: true, stats: true },
      );
    });
  }
  for (const name of [
    "agent_start",
    "agent_end",
    "agent_settled",
    "model_select",
    "thinking_level_select",
  ]) {
    pi.on(name, (_event, ctx) => {
      context = ctx;
      // 模型 / 思考级别变更由宿主事件统一捕获：TUI 里切换也会触发，
      // 而 Web 动作路径（select_model / select_thinking）之后也会收到同一事件，
      // 所以记在这里 + 按值去重，两条路径都覆盖且不重复。
      if (name === "model_select" || name === "thinking_level_select") {
        recordStatusChange(ctx);
      }
      if (name === "agent_end" || name === "agent_settled") {
        // agent_settled 才代表「不会再有自动重试/续跑」，此时判定中止最准；
        // agent_end 可能紧跟一次自动重试，过早记录会误报。
        if (name === "agent_settled") recordInterruption(ctx.sessionManager.getBranch());
        if (responseWaitOwnerId) {
          const index = pendingUserRecords.findIndex(
            (record) => record.message.id === responseWaitOwnerId,
          );
          if (index >= 0)
            removePendingUserRecord(pendingUserRecords[index]);
        }
        responseWaitOwnerId = null;
        responseWaitStartedAt = null;
      }
      publish(
        ctx,
        {
          name: pi.getSessionName() || "未命名会话",
          model: ctx.model
            ? `${ctx.model.provider} / ${ctx.model.id}`
            : "未选择模型",
          selectedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : null,
          thinkingLevels: supportedThinkingLevels(ctx.model),
          thinking: ctx.thinkingLevel || "off",
          busy: !ctx.isIdle(),
          pending: ctx.hasPendingMessages(),
          modelOptions: modelOptions(),
          responseWaitStartedAt,
          pendingUserMessages: pendingUserMessages(),
        },
        {
          history: name === "agent_end" || name === "agent_settled",
          stats: true,
        },
      );
    });
  }
  pi.on("message_update", (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    context = ctx;
    if (responseWaitOwnerId) {
      responseWaitOwnerId = null;
      responseWaitStartedAt = null;
    }
    liveRunId ??= `${ctx.sessionManager.getSessionId()}:live:${randomUUID()}`;
    liveMessage = { ...event.message, id: liveRunId };
    publish(ctx, { liveMessage, responseWaitStartedAt });
  });
  pi.on("message_end", (event, ctx) => {
    context = ctx;
    if (event.message?.role === "assistant") {
      if (liveRunId)
        pendingLiveLinks.set(liveRunId, {
          sessionId: ctx.sessionManager.getSessionId(),
          afterEntryId: ctx.sessionManager.getBranch().at(-1)?.id ?? null,
          message: event.message,
          content: JSON.stringify(event.message.content),
        });
      liveMessage = null;
      liveRunId = null;
      publish(ctx, { liveMessage }, { history: true, stats: true });
    } else publish(ctx, {}, { history: true, stats: true });
  });
  pi.on("message_start", (event, ctx) => {
    context = ctx;
    if (event.message?.role === "user") {
      const sessionId = ctx.sessionManager.getSessionId();
      const content = userMessageText(event.message.content);
      const candidates = pendingUserRecords.filter(
        (record) => record.sessionId === sessionId && !record.acceptedContent,
      );
      const record =
        candidates.find(
          (candidate) => userMessageText(candidate.message.content) === content,
        ) || candidates[0];
      if (record) {
        record.acceptedContent = event.message.content;
        responseWaitOwnerId = record.message.id;
        responseWaitStartedAt ||= Date.now();
      }
    } else if (event.message?.role === "assistant") {
      liveRunId ??= `${ctx.sessionManager.getSessionId()}:live:${randomUUID()}`;
      if (responseWaitOwnerId) {
        responseWaitOwnerId = null;
        responseWaitStartedAt = null;
      }
    }
    publish(
      ctx,
      {
        busy: !ctx.isIdle(),
        pending: ctx.hasPendingMessages(),
        responseWaitStartedAt,
      },
      { history: true },
    );
  });
  pi.on("tool_execution_start", (event, ctx) => {
    context = ctx;
    packageCompatibilities.start(event);
    runningTools.set(
      event.toolCallId,
      normalizeRunningTool(event, { startedAt: Date.now() }),
    );
    publish(ctx, { tools: [...runningTools.values()] });
  });
  pi.on("tool_execution_update", (event, ctx) => {
    context = ctx;
    runningTools.set(
      event.toolCallId,
      normalizeRunningTool(event, runningTools.get(event.toolCallId)),
    );
    publish(ctx, { tools: [...runningTools.values()] });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    context = ctx;
    packageCompatibilities.end(event.toolCallId);
    const running = runningTools.get(event.toolCallId);
    const endedAt = Date.now();
    if (running?.startedAt) {
      completedToolTimings.set(event.toolCallId, {
        startedAt: running.startedAt,
        endedAt,
        durationMs: endedAt - running.startedAt,
      });
      if (completedToolTimings.size > 500)
        completedToolTimings.delete(completedToolTimings.keys().next().value);
      persistState();
    }
    runningTools.delete(event.toolCallId);
    recordToolAbort(event);
    publish(
      ctx,
      {
        tools: [...runningTools.values()],
        toolTimings: Object.fromEntries(completedToolTimings),
      },
      { history: true, stats: true },
    );
  });
  pi.on("session_shutdown", async () => {
    stopPromptQueueListener?.();
    stopPromptQueueListener = undefined;
    stopRendererObserver();
    detachNotifications();
    await stateStore?.close();
    stateStore = undefined;
    displayRecords.length = 0;
    pendingLiveLinks.clear();
    completedLiveIds.clear();
    pendingUserRecords.length = 0;
    responseWaitOwnerId = null;
    responseWaitStartedAt = null;
    packageCompatibilities.clear();
    clearTimeout(publishTimer);
    publishTimer = undefined;
    pendingPatch = undefined;
    pendingSessionId = undefined;
    historyDirty = false;
    statsDirty = false;
    clearTimeout(reloadFallbackTimer);
    reloadFallbackTimer = undefined;
    if (starting) await starting;
    await server?.close();
    server = undefined;
  });
  pi.registerCommand(INTERNAL_RELOAD_COMMAND, {
    description: "pi-atom-web 内部重载桥接",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
      } catch (error) {
        delete globalThis[RELOAD_HANDOFF];
        notifyLocal(ctx, `TUI 重载失败：${error.message}`, "error");
      }
    },
  });
  // 关闭服务（两个命令共用）。
  const stopWebServer = async (ctx) => {
    if (starting) await starting;
    await server?.close();
    server = undefined;
    detachNotifications();
    notifyLocal(ctx, "pi-atom-web 已关闭", "info");
  };
  // 启动服务并记录实例；并发调用复用同一次启动过程。
  const startWebServer = (connection) => {
    starting ??= startServer({ snapshot, action, connection })
      .then((value) => {
        server = value;
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  };
  pi.registerCommand("web", {
    description: "打开当前 TUI 会话的 Web UI（/web stop 关闭服务）",
    handler: async (args, ctx) => {
      context = ctx;
      if (ctx.mode !== "tui") {
        notifyLocal(ctx, "/web 仅用于交互式 TUI", "warning");
        return;
      }
      if (args.trim() === "stop") {
        await stopWebServer(ctx);
        return;
      }
      if (args.trim()) {
        notifyLocal(ctx, "用法：/web 或 /web stop", "warning");
        return;
      }
      try {
        if (!server) await startWebServer();
        attachNotifications();
        notifyLocal(ctx, `pi-atom-web · 当前会话\n${server.url}`, "info");
        if (!(await openBrowser(server.url)))
          notifyLocal(ctx, "未能自动打开浏览器，请打开上方地址", "warning");
      } catch (error) {
        notifyLocal(ctx, `Web UI 启动失败：${error.message}`, "error");
      }
    },
  });
  pi.registerCommand("web-wlan", {
    description:
      "监听 0.0.0.0 打开 Web UI，局域网内设备可访问（凭证仍是唯一凭据）",
    handler: async (args, ctx) => {
      context = ctx;
      if (ctx.mode !== "tui") {
        notifyLocal(ctx, "/web-wlan 仅用于交互式 TUI", "warning");
        return;
      }
      if (args.trim() === "stop") {
        await stopWebServer(ctx);
        return;
      }
      if (args.trim()) {
        notifyLocal(ctx, "用法：/web-wlan 或 /web-wlan stop", "warning");
        return;
      }
      try {
        await starting;
        if (server) {
          // 已在本机模式：就地重绑，复用端口与凭证，已打开的页面不会失效
          const current = server.connection;
          await server.close();
          server = undefined;
          await startWebServer({ ...current, host: "0.0.0.0" });
        } else await startWebServer({ host: "0.0.0.0" });
        attachNotifications();
        // 每张网卡都给出带凭证的完整地址，避免手工拼地址时丢掉 # 片段。
        const addressUrl = (address) => {
          const url = new URL(server.url);
          url.hostname = address;
          return url.toString();
        };
        const lines = ["pi-atom-web · 当前会话（局域网）", server.url];
        const others = (server.addresses || []).slice(1);
        if (others.length)
          lines.push(
            `其他网卡：\n${others
              .map((item) => `${addressUrl(item.address)}（${item.name}）`)
              .join("\n")}`,
          );
        lines.push("该模式不校验 Host/Origin，请仅在可信网络使用，勿泄露上方地址。");
        if (!(server.addresses || []).length)
          lines.push("未找到局域网网卡地址，仍监听 0.0.0.0（只能从本机访问）。");
        notifyLocal(ctx, lines.join("\n"), "warning");
        if (!(await openBrowser(server.url)))
          notifyLocal(ctx, "未能自动打开浏览器，请打开上方地址", "warning");
      } catch (error) {
        notifyLocal(ctx, `Web UI 启动失败：${error.message}`, "error");
      }
    },
  });
}
