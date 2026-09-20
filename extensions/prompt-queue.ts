const RUNTIME = Symbol.for("pi-atom-web.prompt-queue-runtime");

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function messageParts(message) {
  if (typeof message === "string") return { text: message, images: [] };
  if (message && typeof message === "object" && Array.isArray(message.content)) {
    return {
      text: message.content
        .filter((part) => part?.type === "text")
        .map((part) => String(part.text || ""))
        .join("\n"),
      images: message.content
        .filter((part) => part?.type === "image")
        .map((part) => ({ type: "image", mimeType: String(part.mimeType || ""), data: String(part.data || "") })),
    };
  }
  return {
    text: String(message?.text || ""),
    images: [...(message?.images || [])].map((part) => ({
      type: "image",
      mimeType: String(part?.mimeType || ""),
      data: String(part?.data || ""),
    })),
  };
}

function queueItems(kind, messages) {
  return [...(messages || [])].map((message, index) => {
    const { text, images } = messageParts(message);
    const signature = `${text}\0${images.map((image) => `${image.mimeType}:${image.data}`).join("\0")}`;
    return {
      id: `${kind}:${index}:${hashText(signature)}`,
      kind,
      index,
      text,
      images,
    };
  });
}

export function promptQueueSnapshot(steering = [], followUp = [], revision = 0) {
  const steeringItems = queueItems("steer", steering);
  const followUpItems = queueItems("followUp", followUp);
  return {
    revision,
    count: steeringItems.length + followUpItems.length,
    steering: steeringItems,
    followUp: followUpItems,
  };
}

export function createPromptQueueBridge() {
  const sessions = new WeakMap();

  const stateFor = (sessionManager) => {
    const state = sessions.get(sessionManager);
    if (!state) throw new Error("当前 Pi 会话不支持 Prompt 队列管理");
    return state;
  };
  const fullQueue = (state, kind, fallback) => {
    const internal = state.session.agent?.[kind]?.messages;
    return Array.isArray(internal) ? internal : fallback;
  };
  const repairImageOnlyMirror = (session, kind, getter) => {
    const visible = session[getter]?.();
    const actual = session.agent?.[kind]?.messages;
    if (!Array.isArray(visible) || !Array.isArray(actual) || visible.length <= actual.length)
      return false;
    const excess = visible.length - actual.length;
    let remaining = excess;
    for (let index = 0; index < visible.length && remaining > 0; ) {
      if (visible[index] === "") {
        visible.splice(index, 1);
        remaining -= 1;
      } else index += 1;
    }
    return remaining < excess;
  };
  const read = (state) => {
    const steering = state.session.getSteeringMessages?.() || [];
    const followUp = state.session.getFollowUpMessages?.() || [];
    return promptQueueSnapshot(
      fullQueue(state, "steeringQueue", steering),
      fullQueue(state, "followUpQueue", followUp),
      state.revision,
    );
  };
  const notify = (state) => {
    const snapshot = read(state);
    for (const listener of state.listeners) listener(snapshot);
    return snapshot;
  };
  const changed = (state) => {
    state.revision += 1;
    if (state.suppressed || state.notifyScheduled) return;
    state.notifyScheduled = true;
    queueMicrotask(() => {
      state.notifyScheduled = false;
      if (!state.suppressed) notify(state);
    });
  };
  const locate = (snapshot, target) => {
    if (target?.revision !== snapshot.revision)
      throw new Error("Prompt 队列已变化，请刷新后重试");
    const item = [...snapshot.steering, ...snapshot.followUp].find(
      (candidate) => candidate.id === target?.id,
    );
    if (!item) throw new Error("要操作的 Prompt 已不在队列中");
    return item;
  };
  const rebuild = async (state, steering, followUp) => {
    state.suppressed = true;
    try {
      state.session.clearQueue();
      for (const item of steering) await state.session.steer(item.text, item.images);
      for (const item of followUp) await state.session.followUp(item.text, item.images);
    } finally {
      state.suppressed = false;
      // clear + requeue 不是事务。即使某次重新入队失败，也必须把 Pi
      // 当前的真实队列发布出去，避免 Web 继续展示旧快照。
      notify(state);
    }
    return read(state);
  };

  return {
    has(sessionManager) {
      return !!sessionManager && sessions.has(sessionManager);
    },
    attach(session) {
      const sessionManager = session?.sessionManager;
      if (!sessionManager || sessions.has(sessionManager)) return;
      const state = {
        session,
        revision: 0,
        listeners: new Set(),
        suppressed: false,
        notifyScheduled: false,
        unsubscribe: undefined,
      };
      state.unsubscribe = session.subscribe?.((event) => {
        if (event?.type === "queue_update") changed(state);
        // Pi 0.85 only removes its public text mirror when a dequeued user
        // message has text. Image-only messages still disappear from the real
        // agent queue, so publish that authoritative change on message_start.
        if (event?.type === "message_start" && event.message?.role === "user") {
          const repairedSteering = repairImageOnlyMirror(
            session,
            "steeringQueue",
            "getSteeringMessages",
          );
          const repairedFollowUp = repairImageOnlyMirror(
            session,
            "followUpQueue",
            "getFollowUpMessages",
          );
          if (repairedSteering || repairedFollowUp) changed(state);
        }
      });
      sessions.set(sessionManager, state);
    },
    snapshot(sessionManager) {
      return read(stateFor(sessionManager));
    },
    listen(sessionManager, listener) {
      const state = stateFor(sessionManager);
      state.listeners.add(listener);
      listener(read(state));
      return () => state.listeners.delete(listener);
    },
    async add(sessionManager, kind, text, images = []) {
      const state = stateFor(sessionManager);
      const value = String(text || "").trim();
      if (!value && !images.length) throw new Error("排队内容不能为空");
      const before = state.revision;
      if (kind === "steer") await state.session.steer(value, images);
      else if (kind === "followUp") await state.session.followUp(value, images);
      else throw new Error("未知的 Prompt 队列类型");
      if (state.revision === before) changed(state);
      return read(state);
    },
    submit(sessionManager, content, options = {}) {
      const state = stateFor(sessionManager);
      let text;
      let images;
      if (typeof content === "string") {
        text = content;
      } else {
        const textParts = [];
        images = [];
        for (const part of content || []) {
          if (part?.type === "text") textParts.push(part.text);
          else if (part?.type === "image") images.push(part);
        }
        text = textParts.join("\n");
        if (!images.length) images = undefined;
      }
      return new Promise((resolve, reject) => {
        let accepted = false;
        let rejected = false;
        const task = state.session.prompt(text, {
          images,
          streamingBehavior: options.mode,
          expandPromptTemplates: options.expandPromptTemplates ?? false,
          source: "extension",
          preflightResult(ok) {
            if (ok) {
              accepted = true;
              resolve();
            } else {
              rejected = true;
            }
          },
        });
        Promise.resolve(task).then(
          () => {
            // 兼容没有调用 preflightResult 的旧运行时。
            if (!accepted && !rejected) resolve();
          },
          (error) => {
            if (!accepted) reject(error);
            else options.onError?.(error);
          },
        );
      });
    },
    async remove(sessionManager, target) {
      const state = stateFor(sessionManager);
      const before = read(state);
      const removed = locate(before, target);
      const steering = before.steering
        .filter((item) => item.id !== removed.id)
        .map((item) => ({ text: item.text, images: item.images }));
      const followUp = before.followUp
        .filter((item) => item.id !== removed.id)
        .map((item) => ({ text: item.text, images: item.images }));
      const queue = await rebuild(state, steering, followUp);
      return { removed, queue };
    },
    async update(sessionManager, target) {
      const state = stateFor(sessionManager);
      const before = read(state);
      const previous = locate(before, target);
      const text = String(target?.text || "").trim();
      const images = Array.isArray(target?.images) ? target.images : previous.images;
      if (!text && !images.length) throw new Error("Prompt 内容不能为空");
      if (!["steer", "followUp"].includes(target?.kind))
        throw new Error("未知的 Prompt 队列类型");
      const steering = before.steering
        .filter((item) => item.id !== previous.id)
        .map((item) => ({ text: item.text, images: item.images }));
      const followUp = before.followUp
        .filter((item) => item.id !== previous.id)
        .map((item) => ({ text: item.text, images: item.images }));
      const destination = target.kind === "steer" ? steering : followUp;
      const destinationIndex =
        previous.kind === target.kind
          ? Math.min(previous.index, destination.length)
          : destination.length;
      destination.splice(destinationIndex, 0, { text, images });
      const queue = await rebuild(state, steering, followUp);
      const updated = (target.kind === "steer" ? queue.steering : queue.followUp)[
        destinationIndex
      ];
      return { previous, updated, queue };
    },
  };
}

export function installPromptQueueRuntime(AgentSession) {
  const prototype = AgentSession?.prototype;
  if (!prototype || typeof prototype._bindExtensionCore !== "function")
    return createPromptQueueBridge();
  if (prototype[RUNTIME]) return prototype[RUNTIME].bridge;
  const bridge = createPromptQueueBridge();
  const original = prototype._bindExtensionCore;
  Object.defineProperty(prototype, RUNTIME, { value: { bridge, original } });
  prototype._bindExtensionCore = function (runner) {
    bridge.attach(this);
    return original.call(this, runner);
  };
  return bridge;
}
