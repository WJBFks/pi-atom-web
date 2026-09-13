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
    disclosures: {},
    displayRecords: [],
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
        record.message && ["command", "notification"].includes(record.message.role) &&
        typeof record.message.content === "string" && record.message.content.length <= MAX_TEXT)
    : [];
  return {
    schemaVersion: 1,
    toolTimings: timingMap(value.toolTimings),
    thinkingTimings: timingMap(value.thinkingTimings),
    disclosures,
    displayRecords,
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
