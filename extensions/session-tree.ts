/**
 * 会话树兼容层（进程内桥接）。
 *
 * Pi 的会话是树结构（每个 entry 有 id/parentId，当前叶子决定可见分支），
 * `AgentSession.navigateTree(targetId)` 可在**同一会话文件内**切换活跃叶子——
 * 这正是 Web「平行会话」切换与「编辑用户提示词后重开该轮」需要的原语。
 * 但该 API 不在正式扩展 API 里，所以按 prompt-queue 同样的手法：
 * 用带 `Symbol.for()` 防重复包装的 `AgentSession._bindExtensionCore()` 观察器
 * 抓住当前 AgentSession 实例，再转发调用；旧运行时拿不到入口时 `has()` 返回
 * false，上层据此降级（隐藏分支控件、不报错）。
 */
const RUNTIME = Symbol.for("pi-atom-web.session-tree");

export function createSessionTreeBridge() {
  const sessions = new WeakMap();

  return {
    /** 当前运行时是否支持会话树导航（不支持时上层应降级）。 */
    has(sessionManager) {
      return Boolean(sessionManager) && sessions.has(sessionManager);
    },
    attach(session, runner) {
      const sessionManager = session?.sessionManager;
      if (!sessionManager || sessions.has(sessionManager)) return;
      // createCommandContext() 暴露的是 Pi 正式的 navigateTree 动作。上下文里的
      // handler 在调用时才解析，因此即使此刻 AgentSession 还没完成 bindings，稍后
      // 从 Web action 调用时也会落到当前宿主的真实导航实现。
      const commandContext =
        typeof runner?.createCommandContext === "function"
          ? runner.createCommandContext()
          : null;
      sessions.set(sessionManager, { session, commandContext });
    },
    /**
     * 导航到目标 entry（同一文件内切换活跃叶子）。不生成被放弃分支的摘要
     * （`summarize: false`）：旧分支内容原样保留，可随时切回。
     */
    async navigate(sessionManager, targetId) {
      const state = sessions.get(sessionManager);
      if (typeof state?.commandContext?.navigateTree === "function")
        return state.commandContext.navigateTree(targetId, { summarize: false });
      if (!state?.session || typeof state.session.navigateTree !== "function")
        throw new Error("当前 Pi 运行时不支持会话分支切换");
      return state.session.navigateTree(targetId, { summarize: false });
    },
  };
}

export function installSessionTreeRuntime(AgentSession) {
  const prototype = AgentSession?.prototype;
  if (!prototype || typeof prototype._bindExtensionCore !== "function")
    return createSessionTreeBridge();
  if (prototype[RUNTIME]) return prototype[RUNTIME].bridge;
  const bridge = createSessionTreeBridge();
  const original = prototype._bindExtensionCore;
  Object.defineProperty(prototype, RUNTIME, { value: { bridge, original } });
  prototype._bindExtensionCore = function (runner) {
    bridge.attach(this, runner);
    return original.call(this, runner);
  };
  return bridge;
}
