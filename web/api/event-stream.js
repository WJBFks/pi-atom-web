import { validateServerEvent } from "../shared/protocol.js";
import { apiPath } from "./base.js";

export const TOKEN_KEY = "atom-token";
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
  const pathname = location.pathname || "/";
  const base = pathname.endsWith("/") ? pathname : pathname.slice(0, pathname.lastIndexOf("/") + 1);
  const persistentKey = `${TOKEN_KEY}:${base}`;
  let saved = null, sessionToken = null;
  try { saved = globalThis.localStorage?.getItem(persistentKey); } catch {}
  try { sessionToken = get(TOKEN_KEY); } catch {}
  const token = TOKEN_RE.test(fragment) ? fragment : TOKEN_RE.test(sessionToken || "") ? sessionToken : saved;
  if (!TOKEN_RE.test(token || "")) return null;
  try { set(TOKEN_KEY, token); } catch {}
  try { globalThis.localStorage?.setItem(persistentKey, token); } catch {}
  if (TOKEN_RE.test(fragment)) {
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
  // 服务端每 15s 写一行 `: heartbeat`，所以字节流应该一直有动静。
  // 超过 idleLimitMs 没收到任何字节 = 半开连接（机器休眠/网络切换后
  // `reader.read()` 既不 resolve 也不 reject），必须主动拆掉重连。
  idleLimitMs = 40_000,
  // 标签页从后台切回时，沉默超过这个长度就直接换新连接重同步快照。
  resumeStaleMs = 20_000,
  now = () => Date.now(),
}) {
  let stopped = false,
    controller,
    retryTimer,
    generation = 0;
  let expectedSequence,
    streamId,
    sessionId,
    retryAttempt = 0;
  let lastByteAt = 0,
    watchdogTimer,
    staleAbort = false;
  const batcher = createEventBatcher(onEvent, {
    requestFrame,
    cancelFrame,
    setTimer,
    clearTimer,
  });
  const delay = (attempt) =>
    Math.min(10_000, 500 * 2 ** attempt) + Math.floor(random() * 200);
  const clearWatchdog = () => {
    if (watchdogTimer != null) clearTimer(watchdogTimer);
    watchdogTimer = undefined;
  };
  // 收到字节就是存活证据；看门狗到点还没新字节就判定连接已死。
  // 在后台标签页里定时器会被限频，所以还有 `resume()`：切回来时立即再量一次。
  const markAlive = (current) => {
    lastByteAt = now();
    clearWatchdog();
    // idleLimitMs <= 0：只做存活记录、不起看门狗（注入 fake setTimer 的测试用，
    // 也留给不需要该机制的调用方）。
    if (!(idleLimitMs > 0)) return;
    watchdogTimer = setTimer(() => {
      watchdogTimer = undefined;
      if (stopped || current !== generation) return;
      if (now() - lastByteAt < idleLimitMs) {
        markAlive(current);
        return;
      }
      staleAbort = true;
      controller?.abort();
    }, idleLimitMs);
    watchdogTimer.unref?.();
  };

  async function run() {
    if (stopped) return;
    const current = ++generation;
    staleAbort = false;
    controller = new AbortController();
    onState?.("connecting");
    let reader;
    try {
      const response = await fetchImpl(apiPath("api/events"), {
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
      markAlive(current);
      reader = response.body.getReader();
      const decoder = new TextDecoder(),
        parser = createSseParser();
      while (!stopped && current === generation) {
        const { value, done } = await reader.read();
        if (done) throw new Error("连接已断开");
        markAlive(current);
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
      if (stopped || current !== generation) return;
      const aborted = error?.name === "AbortError";
      // 只有看门狗自己发起的 abort 才需要重连；`stop()`/新连接发起的 abort 直接退。
      if (aborted && !staleAbort) return;
      clearWatchdog();
      onError?.(
        aborted
          ? new Error("事件流长时间没有更新，已重新连接")
          : error,
      );
      if (!aborted && error.permanent) {
        onState?.("failed");
        return;
      }
      // 主动判定的陈旧不是退避场景：立刻重连拿新 snapshot。
      if (aborted) {
        staleAbort = false;
        retryAttempt = 0;
      }
      onState?.("reconnecting");
      const wait = aborted ? 0 : delay(retryAttempt);
      retryAttempt += 1;
      retryTimer = setTimer(() => {
        retryTimer = undefined;
        run();
      }, wait);
      retryTimer.unref?.();
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock?.();
    }
  }

  run();
  return {
    /**
     * 标签页从后台切回可见时调用：
     * 1) 先 flush 后台期间合并的最后一帧（rAF 在隐藏页面不触发）；
     * 2) 退避中就直接试一次，不等完退避；
     * 3) 沉默过久（半开连接或 JS 被冻结过）则拆掉重连拿快照。
     */
    resume() {
      batcher.flush();
      if (stopped) return;
      if (retryTimer != null) {
        clearTimer(retryTimer);
        retryTimer = undefined;
        retryAttempt = 0;
        run();
        return;
      }
      if (lastByteAt && now() - lastByteAt >= resumeStaleMs) {
        staleAbort = true;
        controller?.abort();
      }
    },
    stop() {
      stopped = true;
      ++generation;
      clearWatchdog();
      controller?.abort();
      if (retryTimer != null) clearTimer(retryTimer);
      retryTimer = undefined;
      batcher.stop();
    },
  };
}
