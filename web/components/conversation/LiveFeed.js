import { defineComponent, h } from "vue";
import {
  buildToolContext,
  toolResultId,
  useConversationStore,
} from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import MessageItem from "./MessageItem.js";
import ProcessingStatus, { lastBlockType } from "./ProcessingStatus.js";
import ToolCallBlock, { toolLabel } from "./ToolCallBlock.js";
import { useDialogsStore } from "../../stores/dialogs.js";

export default defineComponent({
  name: "LiveFeed",
  props: { trace: Boolean, token: String, onError: Function },
  setup(props) {
    const conversation = useConversationStore();
    const session = useSessionStore();
    const dialogs = useDialogsStore();
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
              token: props.token,
              onError: props.onError,
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
            token: props.token,
            onError: props.onError,
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
      // 运行态状态放在 live 区最后、最新消息正下方。
      // 判定与 HistoryFeed 的「运行中」一致，另加 pendingUserMessages（乐观卡片
      // 已出现、但后端还没开始跑）与 responseWaitStartedAt（preflight 等待中）。
      // 轮次结束后这里不再常驻 —— 最终状态徽标由 HistoryFeed 挂在该轮最后一条
      // 消息的 <article class="message"> 内（见 MessageItem 的 status 插槽）。
      if (!props.trace) {
        const running = conversation.tools[0];
        const runningTool = running
          ? toolLabel(running.toolName || running.name)
          : "";
        const liveType = lastBlockType(live);
        const thinking = liveType === "thinking";
        // 本轮是否已有内容：有 live 消息（正文/思考/工具调用都算）或有运行中的工具。
        const hasContent = Boolean(live) || conversation.tools.length > 0;
        // 「正在等待模型响应」：没有在流式输出、也没有工具在跑，但会话仍在工作。
        // 覆盖两种情况：① 已提交、还没有任何输出（preflight 等待）；
        // ② 刚调用完工具、模型还没开始基于工具结果出字。
        const waitingModel =
          conversation.tools.length === 0 &&
          !live &&
          (session.busy || conversation.responseWaitStartedAt != null);
        // 命令绑定的压缩（Web `/compact`）：压缩状态挂在命令横线下方那一行
        // （`CompactionStatus` → `ProcessingStatus`，带计时与 hover 开始时间），
        // 底部 live 区不再重复显示压缩状态，也不回退成「正在等待模型响应」
        // （压缩期间模型根本没被等待）。TUI / 自动压缩没有命令记录，照旧在这里显示。
        const commandCompaction = conversation.messages.some(
          (message) =>
            message.role === "command" &&
            message.compaction &&
            message.compaction.endedAt == null,
        );
        children.push(
          h(ProcessingStatus, {
            key: "processing",
            // 阻塞时即使会话 idle 也要显示（用户必须先处理阻塞才能继续）。
            // 命令绑定的压缩期间同理不再在这里显示（状态在命令横线下方）；
            // 但已进入 live 区的内容与阻塞提示仍然照旧。
            active:
              dialogs.blocking.length > 0 ||
              hasContent ||
              (!commandCompaction &&
                (session.busy ||
                  conversation.responseWaitStartedAt != null ||
                  conversation.pendingUserMessages.length > 0 ||
                  conversation.compacting)),
            // 处理时间的基准：服务端给的「本轮任务开始时刻」，跨越整轮
            // （含工具调用、多轮往返、被阻塞的时间段），前端不自己记起点。
            // 兜底：理论上 processingStartedAt 一定存在（服务端在 prompt 接管时置位），
            // 但旧后端/中间态可能只带 responseWaitStartedAt —— 用它当起点仍能计时，
            // 只是语义略窄（不含已开始出字的阶段）。
            startedAt:
              conversation.processingStartedAt ??
              conversation.responseWaitStartedAt,
            // 用 blockingNames（完整列表）而不是 blockedParts —— 后者的分段文案
            // 在 ≥3 个时只带前两个名字（「A、B等共N个」），名字会漏。
            blockedNames: dialogs.blockingNames,
            runningTool,
            thinking,
            compacting: conversation.compacting && !commandCompaction,
            waitingModel: !conversation.compacting && waitingModel,
          }),
        );
      }
      return h("div", { id: "message-live" }, children);
    };
  },
});
