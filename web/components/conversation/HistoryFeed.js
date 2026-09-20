import { defineComponent, h } from "vue";
import { messageId, useConversationStore } from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import MessageItem from "./MessageItem.js";
import { formatProcessingDuration } from "./ProcessingStatus.js";
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
  props: { trace: Boolean, token: String, onError: Function },
  setup(props) {
    const conversation = useConversationStore();
    const session = useSessionStore();
    // 每一轮的状态徽标：服务端按该轮**最后一条 assistant 消息**的客户端 id 结算
    // （`<sessionId>:branch:<entryId>`，与 history 消息 id 同格式）并落盘，
    // 刷新后依旧显示。徽标渲染在该消息 <article class="message"> 内、
    // .body 之后（MessageItem 的 status 插槽），而不是 article 外的独立条目。
    const turnStatus = (message) => {
      const id = messageId(message);
      const timing = id ? conversation.turnProcessing[id] : null;
      if (!timing) return null;
      const interrupted = timing.status === "interrupted";
      return {
        interrupted,
        // 完成时刻：服务端以 processingStartedAt（prompt 被接管时）为起点，
        // 轮次结束用 durationMs 结算，两者相加即完成时刻。
        completedAt: timing.startedAt + timing.durationMs,
        durationMs: timing.durationMs,
        text: `${interrupted ? "已中断" : "已完成"}（${formatProcessingDuration(timing.durationMs)}）`,
      };
    };
    const render = (message, key, withStatus = true) =>
      h(MessageItem, {
        key,
        message,
        tools: conversation.historyTools,
        // 用户状态行的编辑/分支切换动作要用凭证；随消息一起透传。
        token: props.token,
        onError: props.onError,
        // 组内消息默认不挂徽标：最终输出的「拆分前半段」与最终消息共用同一 id，
        // 若都允许查表，同一徽标会在折叠组内（上方）和最终输出（下方）各出现一次。
        status: withStatus ? turnStatus(message) : null,
      });
    const renderEntry = (entry, index) => {
      if (entry.kind !== "group") {
        const key = entry.groupKey
          ? `${entry.groupKey}:final`
          : messageId(entry.message) ?? `m${index}`;
        // 独立消息（含某组的最终输出）：id 命中 turnProcessing 就挂徽标。
        return render(entry.message, key);
      }
      const { group, keepOpen } = entry;
      // 中断轮次：最终输出为空、整轮都在组内，徽标改挂组内最后一条 assistant；
      // 正常轮次的徽标挂在组外最终输出上，组内一律不挂。
      let lastAssistantId = null;
      if (!group.finalMessage) {
        for (let i = group.messages.length - 1; i >= 0; i -= 1) {
          if (group.messages[i]?.role === "assistant") {
            lastAssistantId = messageId(group.messages[i]);
            break;
          }
        }
      }
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
              render(
                message,
                `${group.key}:${messageId(message) ?? position}`,
                messageId(message) === lastAssistantId,
              ),
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
