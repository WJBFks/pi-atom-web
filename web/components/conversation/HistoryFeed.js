import { defineComponent, h } from "vue";
import { messageId, useConversationStore } from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import MessageItem from "./MessageItem.js";
import { formatProcessingDuration } from "./ProcessingStatus.js";
import { renderTurnGroup } from "./TurnGroupView.js";
import { groupMessages, splitRunningTail } from "./turnGroups.js";

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
    const render = (message, key, withStatus = true, extraClass = "", blockOffset = 0) =>
      h(MessageItem, {
        key,
        message,
        // 轮次分组用它标记组内首/尾条目：CSS 据此只在这两块把时间轴线段剪短
        // （首个圆点上方不引线、最后一个圆点下方不引线）。
        class: extraClass || undefined,
        tools: conversation.historyTools,
        // 用户状态行的编辑/分支切换动作要用凭证；随消息一起透传。
        token: props.token,
        onError: props.onError,
        // 中间过程组按「消息」切段后的块下标偏移（保住思考块的稳定身份）。
        blockOffset,
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
      // 「组1 / 消息1 / 组2 / …」的渲染结构与 live 区共用同一份实现（见 TurnGroupView.js）：
      // 同一轮只在其中一个容器里出一份 DOM，移交时形状完全一致。
      return renderTurnGroup(entry.group, {
        keepOpen: entry.keepOpen,
        renderUnit: (unit, key, withStatus, extraClass) =>
          render(unit.message, key, withStatus, extraClass, unit.offset),
      });
    };
    return () => {
      const messages = conversation.messages.filter(
        (message) => !props.trace || visibleInTrace(message),
      );
      // **分流边界是「这一轮是否结束」**（用户 2026-09-25）：还在进行的那一整轮（末尾那段没被
      // 「消息」切断的 run）连同正在流式的消息一起交给 live 区渲染，历史只渲染已经结束的轮。
      // 于是正在生成的卡片住在它所属那一轮的 `<details>` 里，分组（只以「消息」划分）、级联折叠
      // 与轮次标题的计数都只有一份计算、一份 DOM。历史这一侧仍只依赖 messages，
      // 流式期间不会重算整段 transcript。
      const { history } = splitRunningTail(messages, {
        running:
          !props.trace &&
          (session.busy ||
            Boolean(conversation.liveMessage) ||
            conversation.tools.length > 0),
        hasPendingUser: conversation.pendingUserMessages.length > 0,
      });
      // 执行轨迹视图保持平铺，不做按轮折叠。
      const entries = props.trace
        ? messages.map((message) => ({ kind: "message", message }))
        : // 进行中的那一轮不在这里，所以历史里没有任何「正在进行」的轮：一律折叠。
          groupMessages(history, { running: false });
      return h("div", { id: "message-history" }, entries.map(renderEntry));
    };
  },
});
