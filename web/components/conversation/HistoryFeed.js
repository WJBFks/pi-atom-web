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
      const { group, running } = entry;
      return h(
        TurnGroup,
        {
          key: group.key,
          blockKey: group.key,
          title: group.title,
          // 执行中默认展开、结束后自动收起；用户手动操作过则以记录状态为准（在 TurnGroup 内处理）
          running,
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
            // 只有整轮输出完全停下来才自动折叠：会话仍在工作（模型还在生成、
            // 工具还在执行）、或仍有流式消息与运行中的工具时，最后一轮保持展开。
            running:
              session.busy ||
              Boolean(conversation.liveMessage) ||
              conversation.tools.length > 0,
          });
      return h("div", { id: "message-history" }, entries.map(renderEntry));
    };
  },
});
