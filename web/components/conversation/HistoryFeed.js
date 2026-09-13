import { defineComponent, h } from "vue";
import { messageId, useConversationStore } from "../../stores/conversation.js";
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
    const render = (message, key) =>
      h(MessageItem, { key, message, tools: conversation.historyTools });
    const renderEntry = (entry, index) => {
      if (entry.kind !== "group") {
        const key = entry.groupKey
          ? `${entry.groupKey}:final`
          : messageId(entry.message) ?? `m${index}`;
        return render(entry.message, key);
      }
      const { group } = entry;
      return h(
        TurnGroup,
        {
          key: group.key,
          blockKey: group.key,
          title: group.title,
          // 一律默认收起；只有用户手动展开过才用记录下来的状态。
          open: conversation.disclosure(group.key),
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
        : groupMessages(messages);
      return h("div", { id: "message-history" }, entries.map(renderEntry));
    };
  },
});
