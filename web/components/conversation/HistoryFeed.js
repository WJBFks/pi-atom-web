import { defineComponent, h } from "vue";
import { messageId, useConversationStore } from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import MessageItem from "./MessageItem.js";
import TurnGroup from "./TurnGroup.js";
import { groupMessages } from "./turnGroups.js";

const visibleInTrace = (message) =>
  [
    "command",
    "notification",
    "customEntry",
    "assistant",
    "toolResult",
    "bashExecution",
  ].includes(message.role);

export default defineComponent({
  name: "HistoryFeed",
  props: { trace: Boolean },
  setup(props) {
    const conversation = useConversationStore();
    const session = useSessionStore();
    const render = (message, key) =>
      h(MessageItem, { key, message, tools: conversation.historyTools });
    const renderEntry = (entry, index) => {
      if (entry.kind !== "group") {
        const key = entry.groupKey
          ? `${entry.groupKey}:final`
          : messageId(entry.message) ?? `m${index}`;
        return render(entry.message, key);
      }
      const { group, keepOpen } = entry;
      return h(
        TurnGroup,
        {
          key: group.key,
          blockKey: group.key,
          title: group.title,
          // 保持展开直到下一个用户输入开始；用户手动操作过则以记录状态为准（在 TurnGroup 内处理）
          keepOpen,
        },
        {
          default: () =>
            group.intermediate.map((message, position) =>
              render(message, `${group.key}:${messageId(message) ?? position}`),
            ),
        },
      );
    };
    return () => {
      const messages = conversation.messages.filter(
        (message) => !props.trace || visibleInTrace(message),
      );
      // 执行轨迹视图保持平铺，不做按轮折叠。
      const entries = props.trace
        ? messages.map((message) => ({ kind: "message", message }))
        : groupMessages(messages, {
            // 已经显示、尚未进入历史的用户消息也算「下一个用户输入开始」。
            nextUserInput: conversation.pendingUserMessages.length > 0,
            // 加载（首次快照 / /reload）时已加载的中间过程全部折叠
            // （会话正在生成时保留正在跑的那一轮）。
            collapseLoaded: conversation.collapseLoaded,
            running:
              session.busy ||
              Boolean(conversation.liveMessage) ||
              conversation.tools.length > 0,
          });
      return h("div", { id: "message-history" }, entries.map(renderEntry));
    };
  },
});
