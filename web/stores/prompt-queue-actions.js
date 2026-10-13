import { shallowRef } from "vue";
import { postAction } from "../api/actions.js";
import { imagePayload } from "../components/composer/image-files.js";
import { useSessionStore } from "./session.js";

/**
 * 队列单条消息的操作（改类型 / 删除）—— 活动组件栏的长条与队列面板共用同一份实现。
 *
 * 这两个动作原先只写在 `PromptQueuePanel` 里；折叠态的队列长条也要能直接改类型与删除后，
 * 逻辑搬到这里，避免两处各自维护 `revision` 校验与报错处理。
 * 所有写入都带当前 `revision`，服务端用它防止模型消费队列时的误改。
 */
export function usePromptQueueActions(token, onError) {
  const session = useSessionStore();
  // 正在提交的那一条 id（同一时刻只允许一条在改）
  const changing = shallowRef(null);

  const run = async (item, action) => {
    if (changing.value) return false;
    changing.value = item.id;
    try {
      await postAction(token, { ...action, sessionId: session.sessionId });
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    } finally {
      changing.value = null;
    }
  };

  /** 把某条队列消息改成 `steer` / `followUp`（可同时改文字与图片）。 */
  const mutate = (item, kind, text = item.text, images = item.images || []) =>
    run(item, {
      type: "queue_update_item",
      id: item.id,
      revision: session.promptQueue.revision,
      kind,
      text,
      images: imagePayload(images),
    });

  /** 删除某条队列消息。 */
  const remove = (item) =>
    run(item, {
      type: "queue_remove",
      id: item.id,
      revision: session.promptQueue.revision,
    });

  return { changing, mutate, remove };
}
