const RUNTIME = Symbol.for("pi-atom-web.prompt-queue-runtime");

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function queueItems(kind, messages) {
  return [...(messages || [])].map((text, index) => ({
    id: `${kind}:${index}:${hashText(text)}`,
    kind,
    index,
    text: String(text),
  }));
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
  const read = (state) =>
    promptQueueSnapshot(
      state.session.getSteeringMessages?.() || [],
      state.session.getFollowUpMessages?.() || [],
      state.revision,
    );
  const notify = (state) => {
    const snapshot = read(state);
    for (const listener of state.listeners) listener(snapshot);
    return snapshot;
  };
  const changed = (state) => {
    state.revision += 1;
    if (!state.suppressed) notify(state);
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
      for (const text of steering) await state.session.steer(text);
      for (const text of followUp) await state.session.followUp(text);
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
        unsubscribe: undefined,
      };
      state.unsubscribe = session.subscribe?.((event) => {
        if (event?.type === "queue_update") changed(state);
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
    async add(sessionManager, kind, text) {
      const state = stateFor(sessionManager);
      const value = String(text || "").trim();
      if (!value) throw new Error("排队内容不能为空");
      const before = state.revision;
      if (kind === "steer") await state.session.steer(value);
      else if (kind === "followUp") await state.session.followUp(value);
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
        .map((item) => item.text);
      const followUp = before.followUp
        .filter((item) => item.id !== removed.id)
        .map((item) => item.text);
      const queue = await rebuild(state, steering, followUp);
      return { removed, queue };
    },
    async update(sessionManager, target) {
      const state = stateFor(sessionManager);
      const before = read(state);
      const previous = locate(before, target);
      const text = String(target?.text || "").trim();
      if (!text) throw new Error("Prompt 内容不能为空");
      if (!["steer", "followUp"].includes(target?.kind))
        throw new Error("未知的 Prompt 队列类型");
      const steering = before.steering
        .filter((item) => item.id !== previous.id)
        .map((item) => item.text);
      const followUp = before.followUp
        .filter((item) => item.id !== previous.id)
        .map((item) => item.text);
      const destination = target.kind === "steer" ? steering : followUp;
      const destinationIndex =
        previous.kind === target.kind
          ? Math.min(previous.index, destination.length)
          : destination.length;
      destination.splice(destinationIndex, 0, text);
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
