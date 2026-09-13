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
      const activated = states.filter(state => state.loading);
      await Promise.all(activated.map(state => state.loading));
      const claims = activated.map(state => state.adapter?.take(factory)).filter(Boolean);
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
