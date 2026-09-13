import { contentBlocks, messageId } from "../../stores/conversation.js";
import { skillLabel } from "./ToolCallBlock.js";

// 一轮的中间过程只由 assistant 与 toolResult 组成；其它角色（用户、命令、通知、
// 自定义 Entry、分支/上下文摘要、终端输出）各自独立渲染，并切断分组。
const PROCESS_ROLES = new Set(["assistant", "toolResult"]);

export const isProcessMessage = (message) => PROCESS_ROLES.has(message?.role);

const toolCallName = (block) => block?.name ?? block?.toolName;
const toolCallArguments = (block) => block?.arguments ?? block?.args;

// 中间过程的构成：思考块、工具调用、技能调用（read SKILL.md）、正文段落。
export function turnCounts(messages) {
  const counts = { thinking: 0, tools: 0, skills: 0, texts: 0 };
  for (const message of messages || []) {
    if (message?.role !== "assistant") continue;
    for (const block of contentBlocks(message.content)) {
      if (block?.type === "thinking") counts.thinking += 1;
      else if (block?.type === "text") counts.texts += 1;
      else if (block?.type === "toolCall") {
        counts.tools += 1;
        if (skillLabel(toolCallName(block), toolCallArguments(block)))
          counts.skills += 1;
      }
    }
  }
  return counts;
}

// 标题按固定顺序（思考过程 → 工具调用 → 技能调用 → 消息）拼接，数量为 0 的分段直接省略。
export function turnTitle(counts) {
  const parts = [];
  if (counts.thinking) parts.push(`${counts.thinking} 次思考过程`);
  if (counts.tools) parts.push(`${counts.tools} 次工具调用`);
  if (counts.skills) parts.push(`${counts.skills} 次技能调用`);
  if (counts.texts) parts.push(`${counts.texts} 条消息`);
  return parts.join(" · ");
}

// 一条 assistant 消息拆成「中间过程」与「最终输出」：
// - 含工具调用的消息整条都算中间过程（它后面还有工具结果）；
// - 否则从最后一个非空正文块开始算最终输出，之前的部分（含同一条里的思考）留在折叠区。
function splitAssistant(message) {
  const blocks = contentBlocks(message.content);
  if (!blocks.length) return { intermediate: [], final: [] };
  if (blocks.some((block) => block?.type === "toolCall"))
    return { intermediate: blocks, final: [] };
  let lastText = -1;
  blocks.forEach((block, index) => {
    if (block?.type === "text" && String(block.text ?? "").trim())
      lastText = index;
  });
  if (lastText < 0) return { intermediate: blocks, final: [] };
  return { intermediate: blocks.slice(0, lastText), final: blocks.slice(lastText) };
}

export function buildTurnGroup(messages) {
  const list = messages || [];
  let finalIndex = -1,
    finalBlocks = [],
    finalIntermediate = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== "assistant") continue;
    const split = splitAssistant(list[index]);
    if (!split.final.length) continue;
    finalIndex = index;
    finalBlocks = split.final;
    finalIntermediate = split.intermediate;
    break;
  }
  // 中间过程保持原顺序；若最后一条消息被拆开，折叠区里放它的前置块（下标因此不变，
  // Thinking 的稳定 identifier 不会被破坏）。
  const intermediate =
    finalIndex < 0
      ? list.slice()
      : [
          ...list.slice(0, finalIndex),
          { ...list[finalIndex], content: finalIntermediate },
        ];
  const counts = turnCounts(intermediate);
  return {
    key: `turn-${messageId(list[0])}`,
    counts,
    title: turnTitle(counts),
    intermediate,
    finalMessage: finalIndex < 0 ? null : list[finalIndex],
    finalBlocks,
    messages: list,
  };
}

// 把扁平的 messages 拆成可直接渲染的条目：单条消息，或一轮的折叠分组 + 它露出的最终输出。
// 折叠时机：只有「下一个用户输入开始」才折叠上一轮（不再是整轮输出一停就折叠）；
// keepOpen 因此表示「本分组之后还没有用户输入」。命令、通知、自定义 Entry、分支/上下文
// 摘要等非用户条目照旧切断分组，但不触发折叠。两个额外开关：nextUserInput 用于浏览器里
// 已经显示、尚未进入历史的用户消息（乐观消息）；collapseTail 用于「加载时全部折叠」。
export function groupMessages(
  messages,
  { nextUserInput = false, collapseTail = false } = {},
) {
  const list = messages || [];
  const items = [];
  let run = [];
  const flush = (keepOpen) => {
    const group = run.length ? buildTurnGroup(run) : null;
    run = [];
    if (!group) return;
    // 没有任何中间过程（只有一条最终输出）时不显示标题，整轮照常平铺渲染。
    if (!group.title) {
      for (const message of group.messages)
        items.push({ kind: "message", message });
      return;
    }
    items.push({ kind: "group", group, keepOpen });
    if (group.finalMessage)
      items.push({
        kind: "message",
        message: { ...group.finalMessage, content: group.finalBlocks },
        groupKey: group.key,
      });
  };
  for (const message of list) {
    if (isProcessMessage(message)) {
      run.push(message);
      continue;
    }
    flush(message.role !== "user");
    items.push({ kind: "message", message });
  }
  flush(collapseTail || nextUserInput ? false : true);
  return items;
}
