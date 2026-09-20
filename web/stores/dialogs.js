import { defineStore } from "pinia";

/**
 * 活动组件的阻塞判定：某些活动组件（如扩展请求）会阻塞会话，
 * 此时必须禁止用户提交新的 prompt。
 *
 * `blocking` 字段由活动组件自身声明；目前扩展请求全部算阻塞。
 * 这里集中一份纯逻辑，供活动栏（红色提示行）与输入区（禁用提交）共用。
 */
export function blockingActivities(requests) {
  return (requests || []).filter((request) => request.blocking !== false);
}

/**
 * 活动的显示名：与活动栏 tab 上的名字保持一致
 * （package 定制名优先，如 ask_user_question → 「提问」）。
 * 用 `look` 注入，避免本模块反向依赖组件层的表。
 */
export function activityName(request, look) {
  return (
    look?.(request)?.label ||
    request.title ||
    `扩展请求 · ${request.kind}`
  );
}

/**
 * 阻塞提示文案的分段：1 个用名称，2 个用「A和B」，3 个及以上用「A、B等共N个活动」。
 *
 * 活动名单独成段（`{code}`），渲染时包成行内代码（`提问`），
 * 因此这里返回结构而不是字符串 —— 别的位置需要纯文本时用 blockedMessage()。
 */
export function blockedMessageParts(requests, look) {
  const blocked = blockingActivities(requests);
  if (!blocked.length) return [];
  const code = (name) => ({ code: name });
  const names = blocked.map((request) => activityName(request, look));
  if (names.length === 1)
    return ["会话已被", code(names[0]), "阻塞，请先处理"];
  if (names.length === 2)
    return ["会话已被", code(names[0]), "和", code(names[1]), "阻塞，请先处理"];
  return [
    "会话已被",
    code(names[0]),
    "、",
    code(names[1]),
    `等共${blocked.length}个活动阻塞，请先处理`,
  ];
}

/** 阻塞提示的纯文本形态（分段里的行内代码用反引号表示）。 */
export function blockedMessage(requests, look) {
  return blockedMessageParts(requests, look)
    .map((part) => (typeof part === "string" ? part : `\`${part.code}\``))
    .join("");
}

export const useDialogsStore = defineStore("dialogs", {
  state: () => ({
    requests: [],
    /** 注入的「请求 → tab 外观」查询函数（由活动栏设置，用于取一致的显示名）。 */
    nameLook: null,
  }),
  getters: {
    /** 当前阻塞会话的活动组件。 */
    blocking: (state) => blockingActivities(state.requests),
    /** 阻塞活动的显示名（与活动栏 tab 一致），按 blockedParts 同样的顺序。 */
    blockingNames: (state) =>
      blockingActivities(state.requests).map((request) =>
        activityName(request, state.nameLook || undefined),
      ),
    /** 阻塞提示分段（无阻塞时为空数组）；渲染用，活动名会包成行内代码。 */
    blockedParts: (state) =>
      blockedMessageParts(state.requests, state.nameLook || undefined),
    /** 阻塞提示纯文本（无阻塞时为空串）；用 state.nameLook 取与 tab 一致的名称。 */
    blockedMessage: (state) =>
      blockedMessage(state.requests, state.nameLook || undefined),
  },
  actions: {
    setActivityLook(look) {
      this.nameLook = look;
    },
    applySnapshot(snapshot) {
      this.requests = snapshot.requests || [];
    },
    applyPatch(patch) {
      if ("requests" in patch) this.requests = patch.requests || [];
    },
  },
});
