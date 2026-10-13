import { defineComponent, h } from "vue";
import {
  buildToolContext,
  messageId,
  toolResultId,
  useConversationStore,
} from "../../stores/conversation.js";
import { useSessionStore } from "../../stores/session.js";
import MessageItem from "./MessageItem.js";
import ProcessingStatus, { lastBlockType } from "./ProcessingStatus.js";
import ToolCallBlock, { toolLabel } from "./ToolCallBlock.js";
import { renderTurnGroup } from "./TurnGroupView.js";
import { buildTurnGroup, splitRunningTail } from "./turnGroups.js";
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
      // **分流边界是「这一轮是否结束」**（用户 2026-09-25）：历史把还在进行的那一整轮摘出来
      // 交给这里，于是正在生成的卡片就住在它所属那一轮的 `<details>` 里 —— 组怎么切（只以
      // 「消息」划分）、级联折叠、轮次标题的计数全是同一份计算结果，不会再出现「live 区自己
      // 临时多切一组」。这里只重算这一轮，已结束的轮仍由历史按 messages 渲染，
      // 所以流式期间依旧不会重算整段 transcript（见 AGENTS.md 的性能红线）。
      const tail = props.trace
        ? []
        : splitRunningTail(conversation.messages, {
            running:
              session.busy || Boolean(live) || conversation.tools.length > 0,
            // 乐观用户消息已经代表新的一轮开始（只是还没进 messages）：这时不摘尾，
            // 否则会把上一轮的尾巴错并进新轮；那条消息落库后自然对齐。
            hasPendingUser: conversation.pendingUserMessages.length > 0,
          }).tail;
      const turnMessages = live ? [...tail, live] : tail;
      // 工具上下文按整轮算：摘出来的那段里 toolCall 也要能与 toolResult 合成同一张卡。
      const tools = buildToolContext(
        turnMessages,
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
      const liveKey = live ? live.id || "live" : null;
      // 思考块的开合与耗时都按 `${消息id}-thinking-${块下标}` 记账，所以判断「是不是正在
      // 流式那条」要比 id：整轮里被拆成「最终输出前置块」的那份是浅拷贝，引用比较会漏。
      const isLive = (message) =>
        Boolean(liveKey) && messageId(message) === liveKey;
      // 执行轨迹视图不分流（整轮仍在历史里平铺），这里只渲染正在流式的那条消息。
      const showTurn =
        turnMessages.length > 0 &&
        (!props.trace ||
          Boolean(
            live &&
              ["assistant", "toolResult", "bashExecution"].includes(live.role),
          ));
      if (showTurn) {
        const group = props.trace ? null : buildTurnGroup(turnMessages);
        const renderUnit = (unit, key, _withStatus, extraClass) =>
          h(MessageItem, {
            key,
            message: unit.message,
            live: isLive(unit.message),
            tools,
            token: props.token,
            onError: props.onError,
            // 中间过程组按「消息」切段后的块下标偏移（保住思考块的稳定身份）。
            blockOffset: unit.offset || 0,
            // 首/尾条目带 `turn-head`/`turn-tail`，否则时间轴引线会悬到下方
            // 「正在思考…/正在等待模型响应…」状态行上。
            class: extraClass || undefined,
          });
        if (group?.title) {
          // 整轮渲染成一个轮次分组，blockKey 与它在历史里时同一个（折叠状态与级联水位线
          // 因此连续，本轮结束移交回历史时不会跳一下）。本轮正在进行 → 保持展开。
          children.push(
            renderTurnGroup(group, {
              keepOpen: true,
              renderUnit,
              // 与历史里的同一个组件，只是多一个标记供 CSS 补容器下方的间距。
              turnProps: { class: "turn-live" },
            }),
          );
          // 最终输出不属于折叠区。
          if (group.finalMessage)
            children.push(
              h(MessageItem, {
                key: `${messageId(group.finalMessage) ?? liveKey}:final`,
                message: {
                  ...group.finalMessage,
                  content: group.finalBlocks,
                },
                live: isLive(group.finalMessage),
                tools,
                token: props.token,
                onError: props.onError,
              }),
            );
        } else {
          // 这一轮还没有任何可计数的中间过程（比如只有一句正在输出的正文）：整轮平铺渲染。
          for (const message of turnMessages)
            children.push(
              h(MessageItem, {
                key: messageId(message) || liveKey,
                message,
                live: isLive(message),
                tools,
                token: props.token,
                onError: props.onError,
              }),
            );
        }
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
