import { defineComponent, h } from "vue";
import {
  buildToolContext,
  toolResultId,
  useConversationStore,
} from "../../stores/conversation.js";
import MessageItem from "./MessageItem.js";
import ResponseWaiting from "./ResponseWaiting.js";
import ToolCallBlock from "./ToolCallBlock.js";

export default defineComponent({
  name: "LiveFeed",
  props: { trace: Boolean },
  setup(props) {
    const conversation = useConversationStore();
    return () => {
      const live = conversation.liveMessage;
      const tools = buildToolContext(
        live ? [live] : [],
        conversation.tools,
        conversation.toolTimings,
      );
      const knownCalls = new Set([
        ...conversation.historyTools.calls.keys(),
        ...tools.calls.keys(),
      ]);
      const children = [];
      if (!props.trace)
        for (const message of conversation.pendingUserMessages)
          children.push(
            h(MessageItem, {
              key: message.id,
              message,
              tools,
            }),
          );
      if (!props.trace && conversation.responseWaitStartedAt != null)
        children.push(
          h(ResponseWaiting, {
            key: `waiting-${conversation.responseWaitStartedAt}`,
            startedAt: conversation.responseWaitStartedAt,
          }),
        );
      if (
        live &&
        (!props.trace ||
          ["assistant", "toolResult", "bashExecution"].includes(live.role))
      ) {
        children.push(
          h(MessageItem, {
            key: live.id || "live",
            message: live,
            live: true,
            tools,
          }),
        );
      }
      for (const running of conversation.tools) {
        const id = toolResultId(running);
        if (id == null || knownCalls.has(String(id))) continue;
        children.push(
          h(ToolCallBlock, {
            key: `running-${id}`,
            call: running,
            running,
            timing: tools.timings.get(String(id)),
            blockKey: `tool-${id}`,
          }),
        );
      }
      return h("div", { id: "message-live" }, children);
    };
  },
});
