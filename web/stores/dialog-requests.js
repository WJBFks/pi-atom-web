import { onUnmounted, reactive, watch } from "vue";
import { useDialogsStore } from "./dialogs.js";
import { useSessionStore } from "./session.js";
import { postAction } from "../api/actions.js";
import {
  cleanupPackageRequestState,
  clearPackageRequestState,
} from "../packages/registry.js";

/**
 * 扩展请求（dialog）的应答逻辑，供通用请求面板与活动组件栏共用。
 *
 * 负责：pending 去重、连接检查、POST dialog_response、按会话/请求 id 清理
 * controller，以及请求结束后清掉 package 草稿状态。
 * 返回 `requests()`（未完成的请求列表）、`pending`（正在提交的 id 集合）与 `respond`。
 */
export function useDialogRequests(token, onError) {
  const dialogs = useDialogsStore(),
    session = useSessionStore(),
    pending = reactive(new Set()),
    completed = reactive(new Set());
  const controllers = new Map();
  let disposed = false;

  const respond = async (id, value, cancel = false) => {
    if (pending.has(id) || completed.has(id)) return;
    const sessionId = session.sessionId;
    if (session.connection !== "connected") {
      onError?.(new Error("连接已断开，请重连后提交"));
      return;
    }
    const controller = new AbortController();
    controllers.set(id, controller);
    pending.add(id);
    try {
      await postAction(
        token,
        {
          type: "dialog_response",
          id,
          sessionId,
          ...(value === undefined ? {} : { value }),
          cancel,
        },
        fetch,
        controller.signal,
      );
      if (disposed || session.sessionId !== sessionId || controller.signal.aborted)
        return;
      completed.add(id);
      clearPackageRequestState(dialogs.requests.find((item) => item.id === id));
    } catch (error) {
      if (!disposed && session.sessionId === sessionId && !controller.signal.aborted)
        onError?.(error);
    } finally {
      controllers.delete(id);
      if (!disposed) pending.delete(id);
    }
  };

  watch(
    () => [session.sessionId, dialogs.requests],
    () => {
      if (!session.sessionId) return;
      const ids = new Set(dialogs.requests.map((request) => request.id));
      for (const [id, controller] of controllers)
        if (!ids.has(id)) {
          controller.abort();
          controllers.delete(id);
          pending.delete(id);
        }
      for (const id of completed) if (!ids.has(id)) completed.delete(id);
      cleanupPackageRequestState(dialogs.requests);
    },
    { immediate: true },
  );

  onUnmounted(() => {
    disposed = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return {
    /** 仍未完成的扩展请求（提交成功或已被移除的不再返回）。 */
    requests: () => dialogs.requests.filter((item) => !completed.has(item.id)),
    pending,
    respond,
  };
}
