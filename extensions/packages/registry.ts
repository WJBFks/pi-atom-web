const descriptors = [
  {
    packageId: "@juicesharp/rpiv-ask-user-question",
    toolName: "ask_user_question",
    eventName: "rpiv:ask-user:prompt",
    load: () => import("./@juicesharp/rpiv-ask-user-question/index.ts"),
  },
];

export function createPackageCompatibilityRegistry(pi) {
  const states = descriptors.map(descriptor => ({
    descriptor,
    starts: [],
    prompts: [],
    adapter: undefined,
    loading: undefined,
  }));

  const activate = state => {
    state.loading ??= state.descriptor.load().then(module => {
      state.adapter = module.default();
      for (const event of state.starts) state.adapter.start(event);
      for (const payload of state.prompts) state.adapter.prompt(payload);
      state.starts.length = 0;
      state.prompts.length = 0;
      return state.adapter;
    }).catch(() => undefined);
    return state.loading;
  };

  for (const state of states)
    pi.events?.on?.(state.descriptor.eventName, payload => {
      // 已激活时直接投递给适配器：缓冲只在“事件先于适配器加载”时用来暂存，
      // 若不过滤就会把历史事件在每次加载/replay 中重复注入，使适配器看到多个
      // 候选而拒绝认领（表现为第二个问卷静默退回通用终端）。
      if (state.adapter) {
        state.adapter.prompt(payload);
        return;
      }
      state.prompts.push(payload);
      void activate(state);
    });

  return {
    start(event) {
      for (const state of states) {
        if (event.toolName !== state.descriptor.toolName) continue;
        if (state.adapter) state.adapter.start(event);
        else state.starts.push(event);
      }
    },
    end(toolCallId) {
      for (const state of states) {
        state.starts = state.starts.filter(event => String(event.toolCallId) !== String(toolCallId));
        state.adapter?.end(toolCallId);
      }
    },
    async takeCustom(factory) {
      // 候选 = 已激活的适配器 + 正在加载的。只按 `loading` 筛会让首次认领之后
      // 的每次请求全部落空（loading 一旦 resolve 就不再进入这个列表），表现为
      // 第二个问卷静默退回通用终端。必须先等加载完成，再询问所有已就绪的适配器。
      const candidates = states.filter(state => state.loading);
      await Promise.all(candidates.map(state => state.loading));
      const ready = states.filter(state => state.adapter);
      const claims = ready.map(state => state.adapter.take(factory)).filter(Boolean);
      return claims.length === 1 ? claims[0] : undefined;
    },
    activePackageIds() {
      return states.filter(state => state.adapter).map(state => state.descriptor.packageId);
    },
    clear() {
      for (const state of states) {
        state.starts.length = 0;
        state.prompts.length = 0;
        state.adapter?.clear();
      }
    },
  };
}
