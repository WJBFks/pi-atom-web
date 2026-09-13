import { defineComponent, h } from "vue";
import { useConversationStore } from "../../stores/conversation.js";
import MessageItem from "./MessageItem.js";

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
    return () =>
      h(
        "div",
        { id: "message-history" },
        conversation.messages
          .filter((message) => !props.trace || visibleInTrace(message))
          .map((message) =>
            h(MessageItem, {
              key: message.id,
              message,
              tools: conversation.historyTools,
            }),
          ),
      );
  },
});
