import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ENTRIES = 500;
const MAX_TEXT = 256 * 1024;

function emptyState() {
  return {
    schemaVersion: 1,
    toolTimings: {},
    thinkingTimings: {},
    compactionTimings: {},
    compactionReasons: {},
    disclosures: {},
    displayRecords: [],
    steeringDeliveries: [],
    turnProcessing: {},
    generation: { tokens: 0, ms: 0, messages: 0 },
  };
}

function timingMap(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, timing] of Object.entries(value).slice(-MAX_ENTRIES)) {
    if (!id || id.length > 1024 || !timing || typeof timing !== "object") continue;
    const startedAt = Number(timing.startedAt),
      endedAt = timing.endedAt == null ? undefined : Number(timing.endedAt),
      durationMs = Number(timing.durationMs);
    if (!Number.isFinite(startedAt) || !Number.isFinite(durationMs) || durationMs < 0) continue;
    result[id] = {
      startedAt,
      ...(Number.isFinite(endedAt) ? { endedAt } : {}),
      durationMs,
    };
  }
  return result;
}

/**
 * 每一轮的处理时长：key = 该轮**最终输出**那条消息的客户端 id
 * （`<sessionId>:branch:<entryId>`，与 history 里消息的 id 同格式），
 * 值为 `{ startedAt, durationMs }`。前端据此在每轮输出下方显示「已完成（时长）」，
 * 刷新后从磁盘恢复。
 */
function turnProcessingMap(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, timing] of Object.entries(value).slice(-MAX_ENTRIES)) {
    if (!id || id.length > 1024 || !timing || typeof timing !== "object") continue;
    const startedAt = Number(timing.startedAt);
    const durationMs = Number(timing.durationMs);
    if (!Number.isFinite(startedAt) || !Number.isFinite(durationMs) || durationMs < 0)
      continue;
    const status =
      timing.status === "interrupted" ? "interrupted" : "done";
    result[id] = { startedAt, durationMs, status };
  }
  return result;
}

/**
 * 压缩条目的触发原因：key = 压缩 entry 的 id，值 = `"manual" | "threshold" | "overflow"`。
 * 宿主只在 `session_compact` **事件**上给 reason，落盘的 `CompactionEntry` 没有这个字段；
 * 而前端要靠它分流：手动压缩是页面边界（不进轮次分组），自动压缩是本轮的一步。
 */
function reasonMap(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, reason] of Object.entries(value).slice(-MAX_ENTRIES))
    if (
      id &&
      id.length <= 1024 &&
      (reason === "manual" || reason === "threshold" || reason === "overflow")
    )
      result[id] = reason;
  return result;
}

/**
 * 会话累计的「正文 + 思考」生成观测（见 extensions/generation-timings.ts）。
 * 只存累计量，不存每条消息的明细：状态栏要的是平均速度，明细没有消费方。
 */
function generationTotals(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyState().generation;
  const count = (input) =>
    Number.isFinite(Number(input)) && Number(input) >= 0 ? Number(input) : 0;
  return {
    tokens: count(value.tokens),
    ms: count(value.ms),
    messages: count(value.messages),
  };
}

function normalize(value, sessionId) {
  if (!value || value.schemaVersion !== 1) return emptyState();
  const disclosures = {};
  if (value.disclosures && typeof value.disclosures === "object")
    for (const [id, open] of Object.entries(value.disclosures).slice(-MAX_ENTRIES))
      if (id && id.length <= 1024 && typeof open === "boolean") disclosures[id] = open;
  const displayRecords = Array.isArray(value.displayRecords)
    ? value.displayRecords.slice(-MAX_ENTRIES).filter((record) =>
        record && record.sessionId === sessionId && typeof record.id === "string" &&
        record.id.length <= 1024 && (record.anchor === null || typeof record.anchor === "string") &&
        // 允许的角色：命令、通知，以及本轮新增的状态提示 / 中止提示。
        // 这里原是 ["command","notification"] 的硬编码白名单，新增角色若不补进来
        // 会被**静默丢弃**（落盘时过滤掉，恢复时自然也没有）。
        record.message &&
        ["command", "notification", "status", "interrupted"].includes(record.message.role) &&
        typeof record.message.content === "string" && record.message.content.length <= MAX_TEXT)
    : [];
  // 以「引导」方式送达的用户消息签名（见 extensions/prompt-queue.ts）。
  // 不存原文，只存 `{hash}:{长度}` 形式的短签名，所以不会泄露 Prompt 内容。
  const steeringDeliveries = Array.isArray(value.steeringDeliveries)
    ? value.steeringDeliveries
        .slice(-MAX_ENTRIES)
        .filter(
          (signature) =>
            typeof signature === "string" &&
            signature.length > 0 &&
            signature.length <= 128,
        )
    : [];
  return {
    schemaVersion: 1,
    toolTimings: timingMap(value.toolTimings),
    thinkingTimings: timingMap(value.thinkingTimings),
    compactionTimings: timingMap(value.compactionTimings),
    compactionReasons: reasonMap(value.compactionReasons),
    disclosures,
    displayRecords,
    steeringDeliveries,
    turnProcessing: turnProcessingMap(value.turnProcessing),
    generation: generationTotals(value.generation),
  };
}

export function createSessionStateStore({ cwd, sessionId, debounceMs = 100 }) {
  if (typeof cwd !== "string" || !cwd) throw new Error("工作区路径无效");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("会话 ID 无效");
  const directory = join(cwd, ".pi", "atom", sessionId);
  const path = join(directory, "web-state.json");
  let state = emptyState(), timer, writing = Promise.resolve(), dirty = false, closed = false;

  const write = async () => {
    if (!dirty) return;
    dirty = false;
    const data = `${JSON.stringify(normalize(state, sessionId), null, 2)}\n`;
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.web-state.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      writing = writing.then(write);
    }, debounceMs);
    timer.unref?.();
  };
  return {
    path,
    value: () => structuredClone(state),
    async load() {
      try { state = normalize(JSON.parse(await readFile(path, "utf8")), sessionId); }
      catch { state = emptyState(); }
      return this.value();
    },
    replace(value) { state = normalize(value, sessionId); dirty = true; schedule(); },
    update(mutator) {
      if (closed) return;
      mutator(state);
      state = normalize(state, sessionId);
      dirty = true;
      schedule();
    },
    async flush() {
      clearTimeout(timer); timer = undefined;
      writing = writing.then(write);
      await writing;
    },
    async close() { closed = true; await this.flush(); },
  };
}
