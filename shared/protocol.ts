/** @typedef {{ schemaVersion: 1, type: 'snapshot'|'patch', streamId: string, sequence: number, sessionId: string, snapshot?: object, patch?: object }} ServerEvent */

const MAX_TEXT_LENGTH = 256 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BASE64 = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;

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
      "notification",
      "customEntry",
      "custom",
      "branchSummary",
      "compactionSummary",
    ].includes(item.role)
  )
    fail(`${name}.role 无效`);
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
    return;
  }
  content(item.content);
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
  if ("questions" in item) {
    if (!Array.isArray(item.questions) || item.questions.length < 1 || item.questions.length > 4)
      fail("request.questions 无效");
    for (const question of item.questions) {
      object(question, "request.question");
      string(question.question, "request.question.question", { max: 32000 });
      string(question.header, "request.question.header", { max: 16 });
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4)
        fail("request.question.options 无效");
      for (const option of question.options) {
        object(option, "request.option");
        string(option.label, "request.option.label", { max: 60 });
        string(option.description, "request.option.description", { empty: true, max: 32000 });
        if ("preview" in option)
          string(option.preview, "request.option.preview", { empty: true, max: MAX_TEXT_LENGTH });
      }
      if ("multiSelect" in question && typeof question.multiSelect !== "boolean")
        fail("request.question.multiSelect 无效");
    }
  }
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

/** Validate a browser action before it reaches the extension bridge. @param {unknown} value @returns {any} */
export function validateAction(value) {
  const action = object(value, "action");
  sessionId(action.sessionId);
  switch (action.type) {
    case "send":
      keysOnly(action, ["type", "sessionId", "text", "images", "mode"], "send");
      string(action.text, "text", { empty: true, max: MAX_TEXT_LENGTH });
      if (action.images !== undefined && !Array.isArray(action.images)) fail("send.images 无效");
      if ((action.images || []).length > 4) fail("send.images 无效");
      let imageBytes = 0;
      for (const image of action.images || []) {
        keysOnly(object(image, "image"), ["mimeType", "data"], "image");
        if (!IMAGE_TYPES.has(image.mimeType)) fail("图片格式不受支持");
        string(image.data, "image.data", { max: MAX_IMAGE_BASE64 });
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) fail("图片数据无效");
        imageBytes += Math.floor((image.data.length * 3) / 4);
      }
      if (imageBytes > 16 * 1024 * 1024) fail("图片总大小超过限制");
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
      keysOnly(action, ["type", "sessionId", "thinkingTimings", "disclosures"], "save_ui_state");
      timings(action.thinkingTimings || {}, "thinkingTimings");
      disclosures(action.disclosures || {}, "disclosures");
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
      if (typeof value !== "boolean") fail(`${key} 无效`);
      break;
    case "responseWaitStartedAt":
      if (value !== null && (!Number.isFinite(value) || value < 0))
        fail(`${key} 无效`);
      break;
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
    case "toolTimings":
    case "thinkingTimings":
      timings(value, key);
      break;
    case "disclosures":
      disclosures(value, key);
      break;
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
