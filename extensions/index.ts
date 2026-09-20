import { stripVTControlCharacters } from "node:util";
import { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createPackageCompatibilityRegistry } from "./packages/registry.ts";
import { bridgeDialogs } from "./dialogs.ts";
import { startServer } from "./server.ts";
import { buildAgentResources } from "./agent-resources.ts";
import { createThinkingTracker } from "./thinking-timings.ts";
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
import { installSessionTreeRuntime } from "./session-tree.ts";

const RELOAD_HANDOFF = Symbol.for("pi-atom-web.reload-handoff");
const promptQueues = installPromptQueueRuntime(AgentSession);
const sessionTree = installSessionTreeRuntime(AgentSession);
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
  // 同一 session 文件内切换树分支时递增。普通历史窗口滑动仍由浏览器做并集；
  // revision 改变的那次 messages patch 则代表另一条活跃分支，必须替换旧分支历史。
  let historyRevision = 0;
  // 本轮任务真正开始的时刻（prompt 被宿主接管那一刻），**跨越整轮**：
  // 期间的工具调用、多轮往返、甚至被活动组件阻塞都算在同一轮里，
  // 只在整轮结束（agent_settled）时清空。前端用它算「处理时间 = 现在 − 它」。
  let processingStartedAt = null;
  // 上下文压缩正在进行中（auto / manual）。压缩期间前端显示「正在压缩上下文...」。
  let compacting = false;
  // 本次压缩的起点与它所属的命令记录 id（`/compact` 命令记录）。
  // **运行态不落盘**：只在序列化输出里挂到那条记录上，完成后才把
  // `{ startedAt, endedAt }` 写进记录（渲染成「压缩完成（耗时…）」），
  // 因此进程中途退出不会残留一个转不完的「正在压缩...」。
  let compactionStartedAt = null;
  let compactionRecordId = null;
  // 「编辑用户提示词后重开该轮」进行中：前端据此在状态行显示「正在重启该轮…」。
  let restarting = false;
  // 每轮的已结算时长：key = 该轮最终输出那条消息的客户端 id
  // （`<sessionId>:branch:<entryId>`，与 history 消息 id 同格式），
  // value = { startedAt, durationMs }。前端据此把「已完成（时长）」贴在**每一轮**的
  // 输出下方（而不是只留一个复用的状态窗），并且落盘，刷新后仍能显示。
  const turnProcessing = new Map();

  /**
   * 本轮最终输出对应的 key：branch 里最后一条 assistant entry 的客户端消息 id。
   * 与前端 history 里该消息的 id 完全一致，所以前端能直接按渲染出的消息 id 查到时长。
   */
  function turnProcessingKey(branch) {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type === "message" && entry.message?.role === "assistant")
        return `${context.sessionManager.getSessionId()}:branch:${entry.id}`;
    }
    return null;
  }

  // 工具调用没有对应的 toolResult：那一轮是在工具跑到一半时被断掉的
  // （强杀 PI / 进程退出，toolResult 永远没写进会话文件）。
  // 由 branch 状态推导而非事件：刷新、重开会话后照样成立。
  // 只在会话空闲时判定 —— 工具「正在跑」时 branch 尾部同样是「有调用无结果」，
  // 那不是中断，不能误报。
  function interruptedTurns(branch) {
    const answered = new Set();
    for (const entry of branch)
      if (entry?.type === "message" && entry.message?.role === "toolResult")
        answered.add(String(entry.message.toolCallId ?? ""));
    const out = new Map();
    for (const entry of branch) {
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      const blocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];
      const dangling = blocks.filter(
        (b) =>
          b?.type === "toolCall" &&
          !answered.has(String(b.id ?? b.toolCallId ?? "")),
      );
      if (dangling.length)
        out.set(
          entry.id,
          dangling.map((b) => b.name ?? b.toolName).filter(Boolean),
        );
    }
    return out;
  }

  // error / aborted 且正文为空的助手消息：原因已由「已中断」提示行完整承载
  // （recordInterruption 读同一条 errorMessage），从历史里滤掉，
  // 避免同一段报错出现两次（红色消息卡 + 提示行）。
  // 带部分正文的保留 —— 那是真实输出，不是报错本身。
  function isSilentErrorAssistant(message) {
    if (message?.role !== "assistant") return false;
    if (message.stopReason !== "error" && message.stopReason !== "aborted")
      return false;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.every((b) => {
      if (b?.type === "toolCall") return false;
      return !String(b?.text ?? b?.thinking ?? "").trim();
    });
  }

  // 刚结束的这轮是否被中断：最后一条是 error/aborted 助手、
  // 出错的工具结果（工具中途 Esc），或停在「有调用无结果」的助手消息上。
  function turnWasInterrupted(branch) {
    const last = branch.at(-1);
    if (last?.type !== "message") return false;
    const m = last.message;
    if (m?.role === "toolResult") return m.isError === true;
    if (m?.role !== "assistant") return false;
    if (m.stopReason === "aborted" || m.stopReason === "error") return true;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const interrupted = interruptedTurns(branch);
    return (
      interrupted.has(last.id) ||
      blocks.some((b) => b?.type === "toolCall" && interrupted.has(last.id))
    );
  }
  let responseWaitOwnerId = null;
  const runningTools = new Map();
  const completedToolTimings = new Map();
  const completedThinkingTimings = new Map();
  // 思考块计时：后端权威。只要扩展加载着就从事件流计时并落盘，
  // 不依赖 Web 是否启动（旧逻辑靠浏览器计时再经 save_ui_state 回传，
  // Web 未启动时整条链路不存在，时长就丢了）。
  const thinkingTracker = createThinkingTracker();
  // 已结算但分支 entry 还没确认：liveId -> { sessionId, settled: {index: timing} }。
  // message_end 时 Pi 还没把消息写进 branch，要等 displayMessages 认领 entry
  // 才能把 key 从 live id 换成历史消息 id（`<sessionId>:branch:<entryId>`）。
  const pendingThinkingSettles = new Map();
  function commitThinkingTimings(historyId, settled) {
    let changed = false;
    for (const [index, timing] of Object.entries(settled)) {
      const key = `${historyId}-thinking-${index}`;
      if (completedThinkingTimings.has(key)) continue;
      completedThinkingTimings.set(key, timing);
      changed = true;
      if (completedThinkingTimings.size > 500)
        completedThinkingTimings.delete(completedThinkingTimings.keys().next().value);
    }
    if (changed) persistState();
    return changed;
  }
  function migrateThinkingTimings(liveId, historyId) {
    const pending = pendingThinkingSettles.get(liveId);
    if (!pending) return;
    pendingThinkingSettles.delete(liveId);
    if (commitThinkingTimings(historyId, pending.settled))
      publish(context, { thinkingTimings: Object.fromEntries(completedThinkingTimings) });
  }
  // message_end 没触发（强杀 / 异常）时的兑底：整轮结束时把残留的思考块
  // 直接结算到 branch 末尾的 assistant entry。
  function fallbackThinkingTimings(ctx) {
    const leftover = thinkingTracker.finish();
    pendingThinkingSettles.clear();
    if (!Object.keys(leftover).length) return;
    const entry = ctx.sessionManager.getBranch().at(-1);
    if (entry?.type !== "message" || entry.message?.role !== "assistant") return;
    const historyId = `${ctx.sessionManager.getSessionId()}:branch:${entry.id}`;
    if (commitThinkingTimings(historyId, leftover))
      publish(ctx, { thinkingTimings: Object.fromEntries(completedThinkingTimings) });
  }
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
      turnProcessing: Object.fromEntries(turnProcessing),
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
    thinkingTracker.reset();
    pendingThinkingSettles.clear();
    disclosures.clear();
    for (const entry of Object.entries(saved.disclosures)) disclosures.set(...entry);
    turnProcessing.clear();
    for (const entry of Object.entries(saved.turnProcessing || {}))
      turnProcessing.set(...entry);
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
    if (promptQueues.has(context.sessionManager)) {
      const result = await promptQueues.submit(
        context.sessionManager,
        content,
        options,
      );
      // Pi emits queue_update before it appends the full user message (including
      // images) to Agent.steeringQueue/followUpQueue. Publish once more at the
      // accepted preflight boundary so the browser cannot get stuck on the
      // earlier text-only mirror.
      const promptQueue = currentPromptQueue();
      publish(context, {
        promptQueue,
        pending: promptQueue.count > 0,
      });
      return result;
    }
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
    const record = {
      id: `${context.sessionManager.getSessionId()}:display:${randomUUID()}`,
      sessionId: context.sessionManager.getSessionId(),
      anchor: branch.at(-1)?.id ?? null,
      message: {
        role,
        content: stripVTControlCharacters(String(text)),
        level,
        ...(detail ? { detail: String(detail).slice(0, 4096) } : {}),
      },
    };
    displayRecords.push(record);
    if (displayRecords.length > 500) displayRecords.shift();
    persistState();
    publish(context, {}, { history: true });
    // 调用方（如 /compact）可能需要在这条记录上补执行状态。
    return record;
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
    // 用户消息的兄弟分支（同一父节点下的多个 user 子节点 = 平行会话）：
    // 一次遍历建表，避免在消息循环里反复扫全量 entry。旧宿主/测试假会话
    // 没有 getEntries() 时回退到当前分支，即视为无平行分支（不发 branch 字段）。
    const allEntries =
      typeof context.sessionManager.getEntries === "function"
        ? context.sessionManager.getEntries() || []
        : branch;
    const entriesById = new Map(allEntries.map((entry) => [entry.id, entry]));
    // 编辑重启回到原用户消息之前后，第三方扩展可能在新 Prompt 写入前通过
    // appendEntry() 插入 custom 状态条目。此时新旧用户消息的直接 parentId 不同，
    // 但仍从同一个对话位置分叉。分支归组因此跳过这些不构成对话轮次的元数据
    // entry，停在最近的真实 message 或结构边界上。
    const transparentParentTypes = new Set([
      "custom",
      "model_change",
      "thinking_level_change",
      "session_info",
      "label",
    ]);
    const userBranchAnchor = (entry) => {
      let parentId = entry.parentId ?? null;
      const visited = new Set();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = entriesById.get(parentId);
        if (!parent || !transparentParentTypes.has(parent.type)) return parentId;
        parentId = parent.parentId ?? null;
      }
      return parentId ?? "";
    };
    const userSiblings = new Map();
    for (const entry of allEntries) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const key = userBranchAnchor(entry);
      const list = userSiblings.get(key);
      if (list) list.push(entry.id);
      else userSiblings.set(key, [entry.id]);
    }
    const entryTimestamp = (entry) => {
      const raw = entry?.timestamp ?? entry?.message?.timestamp;
      const value = typeof raw === "number" ? raw : Date.parse(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    // 用户提示词状态行所需的附加字段：时间戳（本地展示 HH:MM + hover 完整时间戳）
    // 与兄弟分支信息（count > 1 才发，前端据此显示 `< x/y >`）。
    const messageExtras = (entry) => {
      const extras = {};
      const timestamp = entryTimestamp(entry);
      if (timestamp != null) extras.timestamp = timestamp;
      if (entry.message?.role === "user") {
        const ids = userSiblings.get(userBranchAnchor(entry)) || [];
        const index = ids.indexOf(entry.id);
        if (ids.length > 1 && index >= 0)
          extras.branch = {
            index: index + 1,
            count: ids.length,
            prev: index > 0 ? ids[index - 1] : null,
            next: index < ids.length - 1 ? ids[index + 1] : null,
          };
      }
      return extras;
    };
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
    for (const [liveId, pending] of pendingThinkingSettles)
      if (pending.sessionId !== namespace) pendingThinkingSettles.delete(liveId);
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
        migrateThinkingTimings(liveId, `${namespace}:branch:${entry.id}`);
      }
    }
    const withId = (message, id, extras) => ({
      ...message,
      id,
      ...(extras || {}),
      ...(completedLiveIds.has(id) ? { liveId: completedLiveIds.get(id) } : {}),
    });
    // 展示记录（命令/通知/状态提示/中止提示）：压缩进行中时把运行态挂到它所属的
    // 那条命令记录上，前端据此在命令横线下方显示「正在压缩上下文...（x秒）」。
    // 运行态不进 `displayRecords`（不落盘）。
    //
    // **完成态跟着压缩块走**：落盘的 `{ startedAt, endedAt }` 若在本分支存在对应的
    // 压缩条目（命令行 → 压缩块 → 「压缩完成」一行），就从命令记录上摘掉、改挂到
    // 那条 `compactionSummary` 上，由前端渲染在折叠块**下方**，避免同一格完成行
    // 在命令横线处与压缩块下方各出现一次。分支里没有该压缩条目时保留原样，
    // 不留丢失完成行的死角。
    const compactionParents = new Set(
      branch
        .filter((entry) => entry.type === "compaction")
        .map((entry) => entry.parentId),
    );
    const completedByAnchor = new Map();
    for (const record of records) {
      const done = record.message?.compaction;
      if (done && typeof done.endedAt === "number" && record.anchor !== null)
        completedByAnchor.set(record.anchor, {
          startedAt: done.startedAt,
          endedAt: done.endedAt,
        });
    }
    const recordMessage = (record) => {
      if (compacting && compactionRecordId === record.id && compactionStartedAt != null)
        return {
          ...record.message,
          compaction: { startedAt: compactionStartedAt },
        };
      const done = record.message?.compaction;
      if (
        done &&
        typeof done.endedAt === "number" &&
        record.anchor !== null &&
        compactionParents.has(record.anchor)
      ) {
        const { compaction: _moved, ...rest } = record.message;
        return rest;
      }
      return record.message;
    };
    const messages = records
      .filter((r) => r.anchor === null)
      .map((r) => withId(recordMessage(r), r.id));
    // 工具跑到一半被断掉的轮次（强杀等）：agent_settled 没机会跑，
    // recordInterruption 记不了「已中断」，这里按 branch 状态推导一条合成的。
    // 纯派生（不进 displayRecords、不落盘），刷新后重建结果一致。
    const interrupted =
      context.isIdle() ? interruptedTurns(branch) : new Map();
    for (const entry of branch) {
      if (entry.type === "message") {
        if (!isSilentErrorAssistant(entry.message))
          messages.push(
            withId(
              entry.message,
              `${namespace}:branch:${entry.id}`,
              messageExtras(entry),
            ),
          );
        if (interrupted.has(entry.id)) {
          const tools = interrupted.get(entry.id);
          messages.push({
            id: `${namespace}:display:dangling:${entry.id}`,
            sessionId: namespace,
            role: "interrupted",
            content: "已中断",
            detail: tools.length
              ? `工具调用未完成（${tools.join("、")}），会话中途断开`
              : "会话中途断开",
            hint: "点击复制",
          });
        }
      } else if (entry.type === "custom")
        messages.push(
          normalizeCustomEntry(entry, namespace, {
            renderer: entryRenderers.get(entry.customType),
            theme: context.ui?.theme,
            width: 100,
          }),
        );
      else if (entry.type === "compaction") {
        // 压缩条目：渲染成「压缩」可折叠块（摘要行 = 「从N个token中压缩」，
        // 展开 = Pi 写进 branch 的压缩摘要全文）。与 branch_summary 一样，
        // 它是 branch 里的结构条目，不是对话消息。
        // 触发它的那条 `/compact` 命令若已完成，完成行跟着块走（渲染在块下方）。
        const tokensBefore = Number(entry.tokensBefore);
        const done = completedByAnchor.get(entry.parentId);
        messages.push({
          id: `${namespace}:branch:${entry.id}`,
          sessionId: namespace,
          role: "compactionSummary",
          summary: typeof entry.summary === "string" ? entry.summary : "",
          ...(Number.isFinite(tokensBefore) && tokensBefore >= 0
            ? { tokensBefore }
            : {}),
          ...(done ? { compaction: done } : {}),
        });
      }
      messages.push(
        ...records
          .filter((r) => r.anchor === entry.id)
          .map((r) => withId(recordMessage(r), r.id)),
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
      processingStartedAt ||= responseWaitStartedAt;
    }
    publish(context, {
      pendingUserMessages: pendingUserMessages(),
      responseWaitStartedAt,
      processingStartedAt,
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
      // Agent 定义：pi 自动加载的技能/扩展/模板清单与定义文件（设置页只读展示）。
      // 技能/模板来自 pi.getCommands()（真实加载清单），扩展与定义文件按 pi 的
      // 目录发现规则从磁盘镜像；项目未受信时不列出项目级资源。
      agentResources: buildAgentResources({
        cwd: context.cwd,
        isProjectTrusted: Boolean(context.isProjectTrusted?.()),
        getCommands: () => pi.getCommands(),
      }),
      stats: sessionStats(),
      ...windowedMessages(),
      historyRevision,
      pendingUserMessages: pendingUserMessages(),
      responseWaitStartedAt,
      processingStartedAt,
      compacting,
      restarting,
      turnProcessing: Object.fromEntries(turnProcessing),
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
  /** entry 的时间（数值毫秒）；缺失时返回 0 便于比较。 */
  function entryTime(entry) {
    const raw = entry?.timestamp ?? entry?.message?.timestamp;
    const value = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(value) ? value : 0;
  }

  /** 该分支的末端：沿「最新子节点」一路向下，切到某条平行会话时能看到它的完整后续。 */
  function branchTip(entryId) {
    let current = entryId;
    const childrenOf = (id) =>
      typeof context.sessionManager.getChildren === "function"
        ? context.sessionManager.getChildren(id) || []
        : [];
    for (let guard = 0; guard < 4096; guard += 1) {
      const children = childrenOf(current);
      if (!children.length) return current;
      const next = children.reduce(
        (best, item) => (entryTime(item) >= entryTime(best) ? item : best),
        children[0],
      );
      current = next.id;
    }
    return current;
  }

  /** 会话树的写操作（切换活跃叶子）会要求非流式；先等当前响应真正停下来。 */
  async function waitUntilIdle(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!context.isIdle() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!context.isIdle()) throw new Error("等待当前响应结束超时");
  }

  async function abortForTree() {
    if (context.isIdle()) return;
    context.abort();
    await waitUntilIdle();
  }

  async function navigateTree(targetId) {
    if (!sessionTree.has(context.sessionManager))
      throw new Error("当前 Pi 运行时不支持会话分支切换");
    await sessionTree.navigate(context.sessionManager, targetId);
  }

  /**
   * 编辑用户提示词并重发：中断当前生成 → 让 Pi 导航到该用户消息（Pi 会把叶子
   * 定位到它的父节点）→ 以新文本（带原图片）重开该轮。新用户消息因此成为原消息
   * 的兄弟分支，原分支保留可切回。
   */
  async function editUserMessage(input) {
    const entry = context.sessionManager.getEntry(input.entryId);
    if (!entry || entry.type !== "message" || entry.message?.role !== "user")
      throw new Error("只能编辑用户消息");
    const images = Array.isArray(entry.message.content)
      ? entry.message.content.filter((block) => block?.type === "image")
      : [];
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text && !images.length) throw new Error("消息内容不能为空");
    await abortForTree();
    restarting = true;
    publish(context, { restarting });
    try {
      // 必须把“被编辑的用户 entry”交给 Pi，而不是自己导航到 parentId。
      // AgentSession.navigateTree() 对 user entry 有专门语义：自动选择 parentId
      // （根消息则选择 null）、重建 agent.state.messages，并发出 session_tree。
      // 直接 resetLeaf() 只改 SessionManager 指针，会让模型继续带着旧分支上下文。
      await navigateTree(input.entryId);
      const content = images.length
        ? [...(text ? [{ type: "text", text }] : []), ...images]
        : text;
      const record = trackSubmittedPrompt(content, true, true);
      try {
        await submitPrompt(content, {
          mode: "followUp",
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
          processingStartedAt,
        });
        throw error;
      }
      return { restarted: true };
    } finally {
      restarting = false;
      publish(context, { restarting });
    }
  }

  /** 在平行分支间切换：导航到目标兄弟用户消息所在分支的末端。 */
  async function navigateBranch(input) {
    const target = context.sessionManager.getEntry(input.entryId);
    if (!target || target.type !== "message" || target.message?.role !== "user")
      throw new Error("目标分支无效");
    await abortForTree();
    await navigateTree(branchTip(input.entryId));
    return { navigated: true };
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
        input.images,
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
      // 思考时长改由后端从事件流计算并落盘（见 thinkingTracker），
      // 浏览器不再回传 thinkingTimings；这里只接收手动折叠状态。
      disclosures.clear();
      for (const entry of Object.entries(input.disclosures || {})) disclosures.set(...entry);
      persistState();
      publish(context, {
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
    // 用户提示词状态行：编辑重发（重开该轮，产生兄弟分支）与分支切换。
    if (input.type === "edit_user_message")
      return await editUserMessage(input);
    if (input.type === "navigate_branch")
      return await navigateBranch(input);
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
        const record = recordDisplay("command", text);
        // 把本次压缩绑到这条命令记录上（记录 id 在 `record.id`，不在 message 上）：
        // 压缩期间显示「正在压缩上下文...（x秒）」，完成后同一条记录显示
        // 「压缩完成（耗时x）」（见 session_before_compact / session_compact），
        // 压缩摘要本身来自 branch 里的 compaction 条目。
        compactionRecordId = record.id;
        compactionStartedAt = null;
        context.compact({
          ...(args ? { customInstructions: args } : {}),
          onError: (error) => {
            // 压缩没起来：解除绑定，别让下一次（可能是自动）压缩认领这条旧记录。
            if (compactionRecordId === record.id) {
              compactionRecordId = null;
              compactionStartedAt = null;
            }
            context.ui.notify(`上下文压缩失败：${error.message}`, "error");
          },
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
            processingStartedAt,
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
          processingStartedAt,
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
        processingStartedAt,
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
      if (name === "session_tree") historyRevision += 1;
      publish(
        ctx,
        {
          ...(name === "session_tree"
            ? { messages: displayMessages(), historyRevision }
            : {}),
          liveMessage,
          tools: [],
          toolTimings: Object.fromEntries(completedToolTimings),
          thinkingTimings: Object.fromEntries(completedThinkingTimings),
          disclosures: Object.fromEntries(disclosures),
          pendingUserMessages: [],
          responseWaitStartedAt,
          processingStartedAt,
        },
        { history: name !== "session_tree", stats: true },
      );
    });
  }
  // 压缩开始 / 结束：前端据此显示「正在压缩上下文...」而不是误判为「正在等待模型响应」。
  // 注意：这些是扩展面事件（session_*），不是 TUI 内部的 compaction_start/end。
  pi.on("session_before_compact", (_event, ctx) => {
    context = ctx;
    compacting = true;
    compactionStartedAt = Date.now();
    // 带上历史刷新：运行态要挂到那条 /compact 命令记录上（见 displayMessages）。
    publish(ctx, { compacting }, { history: true });
  });
  const endCompaction = (succeeded, _event, ctx) => {
    context = ctx;
    compacting = false;
    // 成功时把起止时间写进触发它的命令记录（落盘，刷新后仍显示「压缩完成（耗时…）」）；
    // 失败时不写 —— 失败提示由 context.compact 的 onError 通知承担。
    if (succeeded && compactionRecordId && compactionStartedAt != null) {
      const record = displayRecords.find(
        (item) => item.id === compactionRecordId,
      );
      if (record) {
        record.message.compaction = {
          startedAt: compactionStartedAt,
          endedAt: Date.now(),
        };
        persistState();
      }
    }
    compactionRecordId = null;
    compactionStartedAt = null;
    // 压缩完成后 branch 里多一条 compaction 摘要条目，刷新历史让前端看到。
    publish(ctx, { compacting }, { history: true, stats: true });
  };
  pi.on("session_compact", (event, ctx) => endCompaction(true, event, ctx));
  pi.on("session_compact_failed", (event, ctx) =>
    endCompaction(false, event, ctx),
  );

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
        if (name === "agent_settled") {
          recordInterruption(ctx.sessionManager.getBranch());
          fallbackThinkingTimings(ctx);
          // 整轮真正结束：结算总时长并清空起点，前端据此显示「已完成（时长）」。
          // 放在 agent_settled 而不是 agent_end：后者后面可能紧跟自动重试/续跑，
          // 那仍属于同一轮，提前结算会让时长偏短。
          if (processingStartedAt != null) {
            const key = turnProcessingKey(ctx.sessionManager.getBranch());
            if (key) {
              turnProcessing.set(key, {
                startedAt: processingStartedAt,
                durationMs: Date.now() - processingStartedAt,
                status: turnWasInterrupted(
                  ctx.sessionManager.getBranch(),
                )
                  ? "interrupted"
                  : "done",
              });
              if (turnProcessing.size > 500)
                turnProcessing.delete(turnProcessing.keys().next().value);
              persistState();
            }
            processingStartedAt = null;
          }
        }
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
          processingStartedAt,
          compacting,
          turnProcessing: Object.fromEntries(turnProcessing),
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
    thinkingTracker.track(event.message);
    thinkingTracker.settle(event.message);
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
      const settled = thinkingTracker.finish();
      if (liveRunId && Object.keys(settled).length)
        pendingThinkingSettles.set(liveRunId, {
          sessionId: ctx.sessionManager.getSessionId(),
          settled,
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
        processingStartedAt ||= responseWaitStartedAt;
      }
    } else if (event.message?.role === "assistant") {
      liveRunId ??= `${ctx.sessionManager.getSessionId()}:live:${randomUUID()}`;
      thinkingTracker.reset();
      thinkingTracker.track(event.message);
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
        processingStartedAt,
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
    thinkingTracker.reset();
    pendingThinkingSettles.clear();
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
