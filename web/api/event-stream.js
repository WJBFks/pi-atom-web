import { validateServerEvent } from "../../shared/protocol.js";

const TOKEN_KEY = "atom-token";
const TOKEN_RE = /^[a-f0-9]{64}$/i;

export function consumeToken(
  location,
  storage = sessionStorage,
  browserHistory = globalThis.history,
) {
  const fragment = String(location.hash || "").slice(1);
  const get = (key) =>
    storage.getItem ? storage.getItem(key) : storage.get(key);
  const set = (key, value) =>
    storage.setItem ? storage.setItem(key, value) : storage.set(key, value);
  const token = TOKEN_RE.test(fragment) ? fragment : get(TOKEN_KEY);
  if (!TOKEN_RE.test(token || "")) return null;
  if (TOKEN_RE.test(fragment)) {
    set(TOKEN_KEY, fragment);
    const path = `${location.pathname || "/"}${location.search || ""}`;
    browserHistory?.replaceState(browserHistory.state ?? null, "", path);
  }
  return token;
}

export function createSseParser() {
  let buffer = "";
  const parse = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return null;
    return JSON.parse(data);
  };
  return {
    push(chunk) {
      buffer += chunk;
      const result = [];
      let at;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
        const value = parse(frame);
        if (value != null) result.push(value);
      }
      return result;
    },
    flush() {
      const value = buffer ? parse(buffer) : null;
      buffer = "";
      return value == null ? [] : [value];
    },
  };
}

export function createEventBatcher(onEvent, options = {}) {
  const requestFrame =
    options.requestFrame ||
    (globalThis.requestAnimationFrame
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback) => setTimeout(callback, 16));
  const cancelFrame =
    options.cancelFrame ||
    (globalThis.cancelAnimationFrame
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : clearTimeout);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let pending,
    frameId,
    fallbackId,
    stopped = false;

  const clearScheduled = () => {
    if (frameId != null) cancelFrame(frameId);
    if (fallbackId != null) clearTimer(fallbackId);
    frameId = fallbackId = undefined;
  };
  const flush = () => {
    if (stopped || !pending) return;
    const event = pending;
    pending = undefined;
    clearScheduled();
    onEvent(event);
  };
  const enqueue = (event) => {
    if (stopped) return;
    if (event.type === "snapshot") {
      flush();
      onEvent(event);
      return;
    }
    pending = pending
      ? { ...event, patch: { ...pending.patch, ...event.patch } }
      : event;
    if (frameId == null) frameId = requestFrame(flush);
    if (fallbackId == null) fallbackId = setTimer(flush, 50);
  };
  return {
    enqueue,
    flush,
    stop() {
      stopped = true;
      pending = undefined;
      clearScheduled();
    },
  };
}

export function createEventStream({
  token,
  onEvent,
  onState,
  onError,
  onSnapshotHeader,
  fetchImpl = fetch,
  requestFrame,
  cancelFrame,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
}) {
  let stopped = false,
    controller,
    retryTimer,
    generation = 0;
  let expectedSequence,
    streamId,
    sessionId,
    retryAttempt = 0;
  const batcher = createEventBatcher(onEvent, {
    requestFrame,
    cancelFrame,
    setTimer,
    clearTimer,
  });
  const delay = (attempt) =>
    Math.min(10_000, 500 * 2 ** attempt) + Math.floor(random() * 200);

  async function run() {
    if (stopped) return;
    const current = ++generation;
    controller = new AbortController();
    onState?.("connecting");
    let reader;
    try {
      const response = await fetchImpl("/api/events", {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (stopped || current !== generation) {
        await response.body?.cancel?.().catch(() => {});
        return;
      }
      if (!response.ok) {
        const error = new Error(
          (await response.json().catch(() => ({}))).error || "连接失败",
        );
        error.permanent = response.status === 401;
        throw error;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder(),
        parser = createSseParser();
      while (!stopped && current === generation) {
        const { value, done } = await reader.read();
        if (done) throw new Error("连接已断开");
        for (const raw of parser.push(
          decoder.decode(value, { stream: true }),
        )) {
          if (stopped || current !== generation) return;
          if (raw?.type === "snapshot" && onSnapshotHeader?.(raw) === true)
            return;
          const event = validateServerEvent(raw);
          if (event.type === "snapshot") {
            expectedSequence = event.sequence;
            streamId = event.streamId;
            sessionId = event.sessionId;
            retryAttempt = 0;
            onState?.("connected");
            batcher.enqueue(event);
            continue;
          }
          if (
            !streamId ||
            event.streamId !== streamId ||
            event.sessionId !== sessionId ||
            event.sequence !== expectedSequence + 1
          )
            throw new Error("事件流不连续");
          expectedSequence = event.sequence;
          batcher.enqueue(event);
        }
      }
    } catch (error) {
      if (stopped || current !== generation || error.name === "AbortError")
        return;
      onError?.(error);
      if (error.permanent) {
        onState?.("failed");
        return;
      }
      onState?.("reconnecting");
      const wait = delay(retryAttempt);
      retryAttempt += 1;
      retryTimer = setTimer(() => {
        retryTimer = undefined;
        run();
      }, wait);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock?.();
    }
  }

  run();
  return {
    stop() {
      stopped = true;
      ++generation;
      controller?.abort();
      if (retryTimer != null) clearTimer(retryTimer);
      retryTimer = undefined;
      batcher.stop();
    },
  };
}
