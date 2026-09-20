/** @typedef {{ schemaVersion: 1, type: 'snapshot'|'patch', streamId: string, sequence: number, sessionId: string, snapshot?: object, patch?: object }} ServerEvent */

const MAX_TEXT_LENGTH = 256 * 1024;
// 单次向前补的历史上限（服务端每页远小于它，仅作为不可信输入的上限）。
const MAX_HISTORY_MESSAGES = 2000;

function fail(message) {
  throw new Error(`无效协议：${message}`);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} 必须是对象`);
  return value;
}
function string(value, name, { empty = false, max = 4096 } = {}) {
  if (typeof value !== "string" || (!empty && !value) || value.length > max)
    fail(`${name} 无效`);
}
function sessionId(value) {
  string(value, "sessionId", { max: 512 });
}
function keysOnly(value, allowed, name) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${name}.${key} 不受支持`);
}
function json(value, depth = 0) {
  if (
    depth > 20 ||
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    fail("JSON value 无效");
  if (value && typeof value === "object")
    for (const item of Array.isArray(value) ? value : Object.values(value))
      json(item, depth + 1);
}
function content(value) {
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH) fail("message content 过长");
    return;
  }
  if (!Array.isArray(value) || value.length > 4096)
    fail("message content 无效");
  for (const block of value) {
    object(block, "message block");
    string(block.type, "message block.type");
    json(block);
  }
}
function message(value, name = "message") {
  const item = object(value, name);
  string(item.id, `${name}.id`, { max: 1024 });
  if (
    ![
      "user",
      "assistant",
      "system",
      "tool",
      "toolResult",
      "bashExecution",
      "command",
      "status",
      "interrupted",
      "notification",
      "customEntry",
      "custom",
      "branchSummary",
      "compactionSummary",
    ].includes(item.role)
  )
    fail(`${name}.role 无效`);
  if (item.role === "interrupted") {
    // 中止原因（aborted / error）与详情可选；正文是简短说明。
    if ("level" in item) string(item.level, `${name}.level`, { empty: true, max: 64 });
    if ("detail" in item)
      string(item.detail, `${name}.detail`, { empty: true, max: MAX_TEXT_LENGTH });
    content(item.content);
    return;
  }
  if (item.role === "status" || item.role === "interrupted") {
    // status：模型/思考级别变更提示；interrupted：中止（用户中断 / 模型或工具报错）。
    if ("level" in item) string(item.level, `${name}.level`, { empty: true, max: 64 });
    if ("detail" in item)
      string(item.detail, `${name}.detail`, { empty: true, max: MAX_TEXT_LENGTH });
    if ("hint" in item) string(item.hint, `${name}.hint`, { empty: true, max: 1024 });
    content(item.content);
    return;
  }
  if (item.role === "bashExecution") {
    string(item.command, `${name}.command`, {
      empty: true,
      max: MAX_TEXT_LENGTH,
    });
    string(item.output, `${name}.output`, {
      empty: true,
      max: MAX_TEXT_LENGTH,
    });
    return;
  }
  if (item.role === "customEntry") {
    string(item.customType, `${name}.customType`, { max: 4096 });
    json(item.data);
    if ("collapsedText" in item)
      string(item.collapsedText, `${name}.collapsedText`, { empty: true, max: MAX_TEXT_LENGTH });
    if ("expandedText" in item)
      string(item.expandedText, `${name}.expandedText`, { empty: true, max: MAX_TEXT_LENGTH });
    if ("timestamp" in item)
      string(item.timestamp, `${name}.timestamp`, { empty: true, max: 4096 });
    return;
  }
  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    string(item.summary, `${name}.summary`, {
      empty: true,
      max: MAX_TEXT_LENGTH,
    });
    // 压缩前 token 数（摘要行「从N个token中压缩」）；缺失时前端退化为「上下文已压缩」。
    if (
      "tokensBefore" in item &&
      (!Number.isFinite(item.tokensBefore) || item.tokensBefore < 0)
    )
      fail(`${name}.tokensBefore 无效`);
    // 压缩条目上的完成行（`压缩完成（耗时…）`，由服务端从命令记录移过来）
    if ("compaction" in item) compactionField(item.compaction, name);
    return;
  }
  content(item.content);
  // 用户提示词状态行所需的附加字段：消息时间戳（本地展示）与同一父节点下的
  // 兄弟分支信息（Pi 会话树：同一父节点下的多个 user 子节点即平行会话）。
  if ("timestamp" in item) {
    if (!Number.isFinite(item.timestamp) || item.timestamp < 0)
      fail(`${name}.timestamp 无效`);
  }
  if ("branch" in item) {
    const branch = object(item.branch, `${name}.branch`);
    if (!Number.isInteger(branch.index) || branch.index < 1)
      fail(`${name}.branch.index 无效`);
    if (!Number.isInteger(branch.count) || branch.count < 2)
      fail(`${name}.branch.count 无效`);
    if (branch.index > branch.count) fail(`${name}.branch.index 超出`);
    for (const key of ["prev", "next"])
      if (branch[key] !== null && typeof branch[key] !== "string")
        fail(`${name}.branch.${key} 无效`);
  }
  // 压缩执行状态：运行中只有 startedAt（挂在命令记录上），
  // 完成后带 endedAt（挂在命令记录或压缩条目上）。
  if ("compaction" in item) compactionField(item.compaction, name);
}
/**
 * 压缩执行状态：`{ startedAt, endedAt? }`。运行中只有 startedAt（命令横线下方显示
 * 「正在压缩上下文...（x秒）」），完成后带 endedAt（「压缩完成（耗时…）」）。
 */
function compactionField(value, name) {
  const compaction = object(value, `${name}.compaction`);
  if (!Number.isFinite(compaction.startedAt) || compaction.startedAt < 0)
    fail(`${name}.compaction.startedAt 无效`);
  if (
    "endedAt" in compaction &&
    (!Number.isFinite(compaction.endedAt) ||
      compaction.endedAt < compaction.startedAt)
  )
    fail(`${name}.compaction.endedAt 无效`);
}
function model(value, name = "model") {
  const item = object(value, name);
  string(item.provider, `${name}.provider`);
  string(item.id, `${name}.id`);
}
function arrayOfObjects(value, name, identifier) {
  if (!Array.isArray(value)) fail(`${name} 必须是数组`);
  for (const item of value) {
    object(item, name);
    if (identifier)
      string(item[identifier] ?? item.id, `${name}.${identifier}`);
  }
}
function dialogRequest(value) {
  const item = object(value, "request");
  string(item.id, "request.id", { max: 1024 });
  string(item.kind, "request.kind", { max: 128 });
  sessionId(item.sessionId);
  if ("packageId" in item) string(item.packageId, "request.packageId", { max: 512 });
  if ("title" in item) string(item.title, "request.title", { empty: true, max: 4096 });
  // Package-scoped payloads stay bounded generically (JSON-safe + total size below);
  // their field-level schema belongs to the package module that owns the request
  // (`extensions/packages/*/`), so the shared protocol stays package-agnostic.
  json(item);
  if (JSON.stringify(item).length > MAX_TEXT_LENGTH) fail("request 过长");
}
function timings(value, name) {
  const items = object(value, name);
  if (Object.keys(items).length > 500) fail(`${name} 过多`);
  for (const [id, timing] of Object.entries(items)) {
    string(id, `${name}.id`, { max: 1024 });
    const item = object(timing, `${name}.${id}`);
    if (!Number.isFinite(item.startedAt) || !Number.isFinite(item.durationMs) || item.durationMs < 0)
      fail(`${name}.${id} 无效`);
    if ("endedAt" in item && !Number.isFinite(item.endedAt)) fail(`${name}.${id}.endedAt 无效`);
  }
}
function disclosures(value, name) {
  const items = object(value, name);
  if (Object.keys(items).length > 500) fail(`${name} 过多`);
  for (const [id, open] of Object.entries(items)) {
    string(id, `${name}.id`, { max: 1024 });
    if (typeof open !== "boolean") fail(`${name}.${id} 无效`);
  }
}
function images(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${name} 无效`);
  for (const image of value) {
    const item = object(image, name);
    keysOnly(item, ["type", "mimeType", "data"], name);
    if ("type" in item && item.type !== "image") fail(`${name}.type 无效`);
    if (typeof item.mimeType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/i.test(item.mimeType))
      fail(`${name}.mimeType 无效`);
    if (typeof item.data !== "string" || !item.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))
      fail(`${name}.data 无效`);
  }
  return value;
}
function promptQueue(value) {
  const queue = object(value, "promptQueue");
  keysOnly(queue, ["revision", "count", "steering", "followUp"], "promptQueue");
  if (!Number.isInteger(queue.revision) || queue.revision < 0)
    fail("promptQueue.revision 无效");
  const validateItems = (items, kind) => {
    if (!Array.isArray(items) || items.length > 500)
      fail(`promptQueue.${kind} 无效`);
    for (const [position, value] of items.entries()) {
      const item = object(value, `promptQueue.${kind}`);
      keysOnly(item, ["id", "kind", "index", "text", "images"], `promptQueue.${kind}`);
      string(item.id, "promptQueue.id", { max: 1024 });
      if (item.kind !== kind || item.index !== position)
        fail(`promptQueue.${kind} 顺序无效`);
      string(item.text, "promptQueue.text", { empty: true, max: MAX_TEXT_LENGTH });
      images(item.images, "promptQueue.images");
    }
  };
  validateItems(queue.steering, "steer");
  validateItems(queue.followUp, "followUp");
  if (queue.count !== queue.steering.length + queue.followUp.length)
    fail("promptQueue.count 无效");
}

/** Validate a browser action before it reaches the extension bridge. @param {unknown} value @returns {any} */
export function validateAction(value) {
  const action = object(value, "action");
  sessionId(action.sessionId);
  switch (action.type) {
    case "send":
      keysOnly(action, ["type", "sessionId", "text", "images", "mode"], "send");
      string(action.text, "text", { empty: true, max: MAX_TEXT_LENGTH });
      images(action.images, "send.images");
      if ((!action.text.trim() && !(action.images || []).length) || !["followUp", "steer"].includes(action.mode))
        fail("send 参数无效");
      break;
    case "abort":
      keysOnly(action, ["type", "sessionId"], "abort");
      break;
    case "select_model":
      keysOnly(
        action,
        ["type", "sessionId", "provider", "modelId"],
        "select_model",
      );
      string(action.provider, "provider");
      string(action.modelId, "modelId");
      break;
    case "select_thinking":
      keysOnly(action, ["type", "sessionId", "level"], "select_thinking");
      if (
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          action.level,
        )
      )
        fail("thinking level 无效");
      break;
    case "dialog_response":
      keysOnly(
        action,
        ["type", "sessionId", "id", "value", "cancel"],
        "dialog_response",
      );
      string(action.id, "dialog id");
      if ("cancel" in action && typeof action.cancel !== "boolean")
        fail("cancel 无效");
      if ("value" in action) {
        json(action.value);
        if (JSON.stringify(action.value).length > MAX_TEXT_LENGTH)
          fail("dialog value 过长");
      }
      break;
    case "save_ui_state":
      // 思考时长改由后端从事件流计算并落盘（extensions/thinking-timings.ts），
      // 浏览器不再回传 thinkingTimings；这里只接收手动折叠状态。
      keysOnly(action, ["type", "sessionId", "disclosures"], "save_ui_state");
      disclosures(action.disclosures || {}, "disclosures");
      break;
    case "more_history":
      // 按游标向前取更早的一段历史（首次快照只带最近若干轮）。
      keysOnly(action, ["type", "sessionId", "cursor"], "more_history");
      string(action.cursor, "cursor", { max: 512 });
      break;
    case "queue_add":
      keysOnly(action, ["type", "sessionId", "kind", "text", "images"], "queue_add");
      if (!["steer", "followUp"].includes(action.kind)) fail("queue_add.kind 无效");
      string(action.text, "queue_add.text", { empty: true, max: MAX_TEXT_LENGTH });
      images(action.images, "queue_add.images");
      if (!action.text.trim() && !(action.images || []).length) fail("queue_add 内容不能为空");
      break;
    case "queue_remove":
      keysOnly(action, ["type", "sessionId", "id", "revision"], "queue_remove");
      string(action.id, "queue_remove.id", { max: 1024 });
      if (!Number.isInteger(action.revision) || action.revision < 0)
        fail("queue_remove.revision 无效");
      break;
    case "queue_update_item":
      keysOnly(action, ["type", "sessionId", "id", "revision", "kind", "text", "images"], "queue_update_item");
      string(action.id, "queue_update_item.id", { max: 1024 });
      if (!Number.isInteger(action.revision) || action.revision < 0)
        fail("queue_update_item.revision 无效");
      if (!["steer", "followUp"].includes(action.kind))
        fail("queue_update_item.kind 无效");
      string(action.text, "queue_update_item.text", { empty: true, max: MAX_TEXT_LENGTH });
      images(action.images, "queue_update_item.images");
      if (!action.text.trim() && !(action.images || []).length)
        fail("queue_update_item 内容不能为空");
      break;
    case "edit_user_message":
      // 编辑用户提示词并重发：服务端先中断当前生成，再导航到该消息的父节点、以新文本
      // 重开该轮，新消息因此成为原消息的兄弟分支。
      keysOnly(action, ["type", "sessionId", "entryId", "text"], "edit_user_message");
      string(action.entryId, "edit_user_message.entryId", { max: 1024 });
      string(action.text, "edit_user_message.text", { empty: true, max: MAX_TEXT_LENGTH });
      break;
    case "navigate_branch":
      // 在平行分支间切换：entryId 是目标兄弟用户消息，服务端解析其子树末端后导航过去。
      keysOnly(action, ["type", "sessionId", "entryId"], "navigate_branch");
      string(action.entryId, "navigate_branch.entryId", { max: 1024 });
      break;
    default:
      fail("action type 无效");
  }
  return value;
}

function validateField(key, value) {
  switch (key) {
    case "instanceId":
      string(value, key, { max: 512 });
      break;
    case "name":
    case "cwd":
    case "model":
      string(value, key, { empty: true, max: MAX_TEXT_LENGTH });
      break;
    case "busy":
    case "pending":
    case "compacting":
    case "restarting":
      if (typeof value !== "boolean") fail(`${key} 无效`);
      break;
    case "responseWaitStartedAt":
    // 本轮任务真正开始的时刻（prompt 被接管的瞬间）。与 responseWaitStartedAt 不同：
    // 它跨越整轮（含工具调用、多轮往返），只在整轮结束时清空。
    case "processingStartedAt":
      if (value !== null && (!Number.isFinite(value) || value < 0))
        fail(`${key} 无效`);
      break;
    // 每轮的已结算时长：key = 该轮最终输出那条消息的客户端 id，
    // value = { startedAt, durationMs }。前端在每一轮输出下方显示「已完成（时长）」。
    case "turnProcessing": {
      const entries = object(value, key);
      if (Object.keys(entries).length > 500) fail(`${key} 过多`);
      for (const timing of Object.values(entries)) {
        object(timing, `${key} 项`);
        if (
          !Number.isFinite(timing.startedAt) ||
          !Number.isFinite(timing.durationMs) ||
          timing.durationMs < 0
        )
          fail(`${key} 项无效`);
        if (
          timing.status !== undefined &&
          timing.status !== "done" &&
          timing.status !== "interrupted"
        )
          fail(`${key} 项 status 无效`);
      }
      break;
    }
    case "thinking":
      string(value, key);
      break;
    case "selectedModel":
      if (value !== null) model(value, key);
      break;
    case "modelOptions":
      if (!Array.isArray(value)) fail(`${key} 必须是数组`);
      for (const item of value) {
        model(item, key);
        string(item.name, `${key}.name`, { empty: true });
        if (
          typeof item.reasoning !== "boolean" ||
          !Array.isArray(item.thinkingLevels)
        )
          fail(`${key} 无效`);
      }
      break;
    case "thinkingLevels":
    case "commands":
      if (!Array.isArray(value)) fail(`${key} 必须是数组`);
      break;
    case "stats":
      object(value, key);
      break;
    case "messages":
      for (const item of value || []) message(item);
      if (!Array.isArray(value)) fail("messages 必须是数组");
      break;
    case "prependMessages":
      // 向前补的更早历史，客户端只做前置拼接，不做替换。
      if (!Array.isArray(value)) fail("prependMessages 必须是数组");
      if (value.length > MAX_HISTORY_MESSAGES) fail("prependMessages 过长");
      for (const item of value) message(item, "prependMessage");
      break;
    case "historyComplete":
      if (typeof value !== "boolean") fail("historyComplete 无效");
      break;
    case "historyRevision":
      if (!Number.isSafeInteger(value) || value < 0)
        fail("historyRevision 无效");
      break;
    case "pendingUserMessages":
      for (const item of value || []) {
        message(item, "pendingUserMessage");
        if (item.role !== "user") fail("pendingUserMessage.role 无效");
      }
      if (!Array.isArray(value)) fail("pendingUserMessages 必须是数组");
      break;
    case "liveMessage":
      if (value !== null) message(value, "liveMessage");
      break;
    case "tools":
      arrayOfObjects(value, key, "toolCallId");
      break;
    case "requests":
      if (!Array.isArray(value) || value.length > 64) fail("requests 必须是数组");
      for (const item of value) dialogRequest(item);
      break;
    case "promptQueue":
      promptQueue(value);
      break;
    case "toolTimings":
    case "thinkingTimings":
      timings(value, key);
      break;
    case "disclosures":
      disclosures(value, key);
      break;
    case "agentResources": {
      // Agent 定义（设置页只读展示）：技能/扩展/模板清单 + 定义文件。
      const res = object(value, key);
      for (const listKey of ["skills", "extensions", "prompts"]) {
        const list = res[listKey];
        if (!Array.isArray(list) || list.length > 500)
          fail(`${key}.${listKey} 无效`);
        for (const item of list) {
          const it = object(item, `${key}.${listKey} 项`);
          string(it.name, `${key}.${listKey}.name`);
          string(it.path, `${key}.${listKey}.path`, { empty: true });
          if (!["global", "project", "package"].includes(it.source))
            fail(`${key}.${listKey}.source 无效`);
          if (it.description !== undefined)
            string(it.description, `${key}.${listKey}.description`, {
              empty: true,
            });
          if (it.sourceName !== undefined)
            string(it.sourceName, `${key}.${listKey}.sourceName`);
        }
      }
      const def = object(res.definition, `${key}.definition`);
      if (!Array.isArray(def.contextFiles) || def.contextFiles.length > 64)
        fail(`${key}.definition.contextFiles 无效`);
      for (const item of def.contextFiles) {
        const it = object(item, `${key}.contextFiles 项`);
        string(it.path, `${key}.contextFiles.path`);
        if (!Number.isFinite(it.size) || it.size < 0)
          fail(`${key}.contextFiles.size 无效`);
      }
      if (def.systemPromptFile !== null)
        string(def.systemPromptFile, `${key}.definition.systemPromptFile`);
      if (def.appendSystemPromptFile !== null)
        string(
          def.appendSystemPromptFile,
          `${key}.definition.appendSystemPromptFile`,
        );
      if (!Array.isArray(def.settings) || def.settings.length > 8)
        fail(`${key}.definition.settings 无效`);
      for (const item of def.settings) {
        const it = object(item, `${key}.settings 项`);
        string(it.path, `${key}.settings.path`);
        if (typeof it.exists !== "boolean")
          fail(`${key}.settings.exists 无效`);
      }
      if (!Array.isArray(def.packages) || def.packages.length > 128)
        fail(`${key}.definition.packages 无效`);
      for (const p of def.packages) string(p, `${key}.packages 项`);
      if (typeof def.projectTrusted !== "boolean")
        fail(`${key}.definition.projectTrusted 无效`);
      break;
    }
    default:
      fail(`patch.${key} 不受支持`);
  }
}

/** Validate a full session snapshot. @param {unknown} value @returns {any} */
export function validateSnapshot(value) {
  const snapshot = object(value, "snapshot");
  if (snapshot.schemaVersion !== 1) fail("snapshot schemaVersion 无效");
  sessionId(snapshot.sessionId);
  string(snapshot.instanceId, "instanceId", { max: 512 });
  string(snapshot.name, "name", { empty: true, max: 4096 });
  string(snapshot.cwd, "cwd", { empty: true, max: MAX_TEXT_LENGTH });
  for (const [key, field] of Object.entries(snapshot))
    if (!["schemaVersion", "sessionId"].includes(key))
      validateField(key, field);
  return value;
}

/** Validate one SSE payload. @param {unknown} value @returns {any} */
export function validateServerEvent(value) {
  const event = object(value, "event");
  if (event.schemaVersion !== 1) fail("schemaVersion 无效");
  if (!["snapshot", "patch"].includes(event.type)) fail("event type 无效");
  string(event.streamId, "streamId", { max: 512 });
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    fail("sequence 无效");
  sessionId(event.sessionId);
  if (event.type === "snapshot") {
    if ("patch" in event || !("snapshot" in event)) fail("snapshot event 无效");
    validateSnapshot(event.snapshot);
    if (event.snapshot.sessionId !== event.sessionId)
      fail("snapshot sessionId 不匹配");
  } else {
    if ("snapshot" in event || !("patch" in event)) fail("patch event 无效");
    const patch = object(event.patch, "patch");
    if (!Object.keys(patch).length) fail("patch 不能为空");
    for (const [key, field] of Object.entries(patch)) validateField(key, field);
  }
  return value;
}
