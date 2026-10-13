import { contentBlocks, messageId } from "../../stores/conversation.js";
import { isSoloTool } from "../../packages/tool-profiles.js";
import { skillLabel } from "./ToolCallBlock.js";

// 一轮的中间过程由 assistant、toolResult 与**自动**压缩条目组成：自动压缩（阈值 / 溢出恢复）
// 发生在同一个 agent run 内部，和引导消息一样是本轮流程里的一步，不能把一个连续任务切断。
// **手动压缩（`/compact`）不是**：那是用户显式按下的页面边界，像普通用户输入一样切断分组、
// 自己单独渲染（靠服务端下发的 `compactionReason: "manual"` 识别，缺失时保持旧行为）。
// 其它角色（用户、命令、通知、分支/上下文摘要、终端输出）各自独立渲染，并切断分组。
// **「其他」条目（`customEntry`）不在这个集合里**：它可能是本轮过程的一部分（一次搜索的结果），
// 也可能是扩展在空闲时写的心跳 / 面板状态，两者必须分开处理（判据 `otherSitsInTurn()`）。
const PROCESS_ROLES = new Set(["assistant", "toolResult", "compactionSummary"]);

export const isProcessMessage = (message) =>
  PROCESS_ROLES.has(message?.role) && !isManualCompactionMessage(message);

/** 手动 `/compact` 产生的压缩条目：它是用户显式按下的页面边界，不算中间过程。 */
export const isManualCompactionMessage = (message) =>
  message?.role === "compactionSummary" && message?.compactionReason === "manual";

/**
 * 自动压缩条目：branch 里的 `type:"compaction"` entry 由服务端转成 `role:"compactionSummary"`
 * 的 Web 消息（见 COMPATIBILITY-API.md）。它没有正文块，只在标题里计入「压缩`n`」。
 * 手动压缩（`compactionReason === "manual"`）不算中间过程，因此不返回 true。
 */
export const isCompactionMessage = (message) =>
  message?.role === "compactionSummary" && message?.compactionReason !== "manual";

/**
 * 引导（steer）送达的用户消息：宿主在当前轮的工具间隙把它注入同一个 agent run，
 * 所以它属于**原消息那一轮**的流程，不能像普通用户输入那样切断分组。
 * 来源标记由服务端从 Prompt 队列推定（`delivery: "steer"`，见 COMPATIBILITY-API.md）。
 */
export const isSteeringMessage = (message) =>
  message?.role === "user" && message?.delivery === "steer";

/**
 * 「其他」条目：扩展用 `appendEntry` 写进 branch 的 custom 条目，服务端转成
 * `role: "customEntry"`（`extensions/custom-entry.ts`）。**页面对这一类的统称是「其他」**
 * （用户 2026-09-25 定名）：卡片标题仍显示各家的 `customType` 原名，只有轮次/组标题里的
 * 计数分段叫「其他`n`」，不为任何一家做专属视图。
 */
export const isOtherEntry = (message) => message?.role === "customEntry";

/**
 * 「其他」条目算不算**本轮对话过程**（用户 2026-09-25 补口径：“只有对话过程中的「其他」会进组，
 * `wj-scheduler-status` 这些心跳通常不在对话过程中，它们还是一个一个平铺”）：
 * **只有它夹在本轮的过程消息之间**才算 —— 向前、向后各跳过连续的「其他」，两端都必须是
 * `isProcessMessage`。搜索结果正好是 `assistant(toolCall) → 其他 → toolResult`，因此归组；
 * 扩展空闲时写的心跳 / 面板状态两端都不是过程消息，继续像通知那样一条一条平铺。
 *
 * 判据只看“左右邻居”，所以正序遍历（`groupMessages`）与尾部回溯（`trailingProcessRun`）
 * 用的是同一把尺子 —— 两边不一致会让同一条条目在历史区与 live 区之间跳。
 */
const otherSitsInTurn = (list, index) => {
  let before = index - 1;
  while (before >= 0 && isOtherEntry(list[before])) before -= 1;
  let after = index + 1;
  while (after < list.length && isOtherEntry(list[after])) after += 1;
  return isProcessMessage(list[before]) && isProcessMessage(list[after]);
};

// package 工具档案里标了 `solo` 的工具（当前只有提问卡）：卡片**单独平铺，不进中间过程组**，
// 但**轮次标题仍把它算进「工具调用」**：计数用的是 `turnCounts(intermediate)`（整段），
// 与它在不在组里无关；组标题只算本组，因此不含它。
// 工具名不写在这通用文件里，查表逻辑与字面量见 `web/packages/tool-profiles.js`（§21）。
const isSoloToolBlock = (block) =>
  block?.type === "toolCall" && isSoloTool(block?.name ?? block?.toolName);

/** solo 工具的结果条：卡片已按 `toolCallId` 合并它（`MessageItem` 对这种情况返回 `null`），
 *  但它仍会占一个组位，所以跟着一起平铺，否则它会单独撑出一个只渲染「中间过程」标题的空组。 */
const isSoloToolResult = (message) =>
  message?.role === "toolResult" && isSoloTool(message?.toolName);

const toolCallName = (block) => block?.name ?? block?.toolName;
const toolCallArguments = (block) => block?.arguments ?? block?.args;

// 中间过程的构成：思考块、工具调用、技能调用（read SKILL.md）、正文段落，以及本轮的元信息
// （引导次数、其他条目数、压缩次数）。
export function turnCounts(messages) {
  const counts = {
    thinking: 0,
    tools: 0,
    skills: 0,
    texts: 0,
    steers: 0,
    others: 0,
    compactions: 0,
  };
  for (const message of messages || []) {
    if (isSteeringMessage(message)) {
      counts.steers += 1;
      continue;
    }
    if (isOtherEntry(message)) {
      counts.others += 1;
      continue;
    }
    if (isCompactionMessage(message)) {
      counts.compactions += 1;
      continue;
    }
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

// 标题按固定顺序（思考 → 工具调用 → 技能调用 → 消息 → 引导 → 压缩 → 其他）拼接，
// 数量为 0 的分段直接省略。前四段是「这一轮做了什么」，按流程顺序排；「引导」（被插话几次）、
// 「压缩」（被压缩几次）与「其他」（本轮过程里了几条扩展旁路条目）是本轮的元信息，
// 因此排在流程之后，**「其他」固定垫底**（用户 2026-09-25：“让其他垫底”，取代原先的压缩垫底）。
// 每段是「类型名 + 数量」：数量在页面上渲染成行内代码样式的徽片（见 `TurnGroup`），
// 所以这里输出结构而不是拼好的字符串。
export const TURN_COUNT_LABELS = [
  ["thinking", "思考"],
  ["tools", "工具调用"],
  ["skills", "技能调用"],
  ["texts", "消息"],
  ["steers", "引导"],
  ["compactions", "压缩"],
  ["others", "其他"],
];

export function turnTitleParts(counts) {
  return TURN_COUNT_LABELS.filter(([key]) => Number(counts?.[key]) > 0).map(
    ([key, label]) => ({ label, value: counts[key] }),
  );
}

// 纯文本形式（无 DOM 场景与测试用）：与页面同一文案，只是不带样式。
export function turnTitle(counts) {
  return turnTitleParts(counts)
    .map((part) => `${part.label}${part.value}`)
    .join(" · ");
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

/**
 * 「消息」块：非空正文块。它不算中间过程组的内容，而是**把组切断的分隔物**（用户
 * 2026-09-24）：一轮的中间过程不再平铺成一长串，而是被正文切成若干「中间过程组」：
 * 组1 / 消息1 / 组2 / 消息2 / 组3，最终输出仍在轮次分组外面。
 */
const isTextBlock = (block) =>
  block?.type === "text" && String(block.text ?? "").trim().length > 0;

/**
 * **单独展示**的条目（用户 2026-09-25 规定）：引导块与自动压缩块不折进中间过程组，
 * 而是像「消息」一样平铺在组之间。提问本来就会切断分组（`groupMessages`），已经在组外；
 * 手动压缩走同一边的切断分支，也根本不会进到组里。
 * 平铺后它们拿不到时间轴圆点（那些规则全部以 `.turn-stage` 为前缀），也不跟着平铺正文发灰。
 */
const isSoloEntry = (message) =>
  isSteeringMessage(message) || isCompactionMessage(message);

/**
 * 把一轮的 intermediate 切成可直接渲染的 `body`，并附带 `stages`。
 *
 * - `body` 的元素：`{ kind: "stage", stage }` 或 `{ kind: "text", unit }`（平铺在组之间的「消息」）；
 * - `unit = { message, offset }`：`message.content` 是原块数组的**切片**，`offset` 是切片在
 *   原数组里的起始下标。**思考块的身份是 `${消息id}-thinking-${块下标}`**（见 store 的
 *   `thinkingBlocks`），所以切片必须带偏移，否则思考耗时与开合状态会全部错位；
 * - 非 assistant 消息里**工具结果**与「其他」条目（`customEntry`，且夹在本轮过程之间）整条归当前组；
 * 引导、自动压缩与 **solo 工具的结果条**平铺（见 `isSoloEntry` / `isSoloToolResult`）。
 * assistant 消息里的 **solo 工具卡**也是分隔物（块级判据 `isSoloToolBlock`），平铺在组之间。
 * 空组（组里一个块都没有，比如两个正文背靠背）不输出，标题下标因此是连续分配的。
 */
export function splitTurnStages(intermediate, groupKey) {
  const seq = [];
  let items = null;
  const ensure = () => {
    if (!items) {
      items = [];
      seq.push({ kind: "stage", items });
    }
    return items;
  };
  const push = (message, blocks, offset) => {
    ensure().push({
      message: blocks ? { ...message, content: blocks } : message,
      offset,
    });
  };
  for (const message of intermediate || []) {
    // 引导 / 压缩：先关掉当前组，再像「消息」那样平铺在组之间（用户 2026-09-25）。
    if (isSoloEntry(message)) {
      items = null;
      seq.push({ kind: "text", unit: { message, offset: 0 } });
      continue;
    }
    // solo 工具的结果条：卡片已经合并了它（渲染成 null），平铺即可，不能让它开出一个空组。
    if (isSoloToolResult(message)) {
      items = null;
      seq.push({ kind: "text", unit: { message, offset: 0 } });
      continue;
    }
    if (message?.role !== "assistant") {
      push(message, null, 0);
      continue;
    }
    const blocks = contentBlocks(message.content);
    // 块数组为空时分两种：字符串正文（真实快照里很常见，要当「消息」平铺，不能丢也不能
    // 归进组）与真的没内容（包括 buildTurnGroup 为最终输出留的那份空壳）—— 后者直接跳过，
    // 否则每轮末尾会多出一条空气泡。
    if (!blocks.length) {
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      items = null;
      seq.push({ kind: "text", unit: { message, offset: 0 } });
      continue;
    }
    let from = 0;
    blocks.forEach((block, index) => {
      if (!isTextBlock(block) && !isSoloToolBlock(block)) return;
      if (index > from) push(message, blocks.slice(from, index), from);
      items = null; // 正文与 solo 工具卡平铺在组之间，下一段开新组
      seq.push({
        kind: "text",
        // 与组内条目同形状（message.content 就是切片）：渲染端只读 unit.message，
        // 否则会把整条消息（含思考块）重复渲染一遍。
        unit: { message: { ...message, content: [block] }, offset: index },
      });
      from = index + 1;
    });
    if (from < blocks.length) push(message, blocks.slice(from), from);
  }
  const stages = [];
  const body = [];
  for (const entry of seq) {
    if (entry.kind === "text") {
      body.push(entry);
      continue;
    }
    if (!entry.items.length) continue;
    const counts = turnCounts(entry.items.map((item) => item.message));
    const titleParts = turnTitleParts(counts);
    // 纯工具/思考组成的组一定有计数；真的没有任何可计数块时给一个通用标题，
    // 避免出现一个空标题的折叠块。
    const stage = {
      key: `${groupKey}:stage-${stages.length}`,
      counts,
      titleParts,
      title: titleParts.length
        ? titleParts.map((part) => `${part.label}${part.value}`).join(" · ")
        : "中间过程",
      items: entry.items,
    };
    stages.push(stage);
    body.push({ kind: "stage", stage });
  }
  return { body, stages };
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
  const titleParts = turnTitleParts(counts);
  // 轮次标题仍是**全轮总数**（各组之和 + 消息数，用户 2026-09-24 选定），
  // 下面拆出的中间过程组只算自己那一段。
  const { body, stages } = splitTurnStages(intermediate, `turn-${messageId(list[0])}`);
  return {
    key: `turn-${messageId(list[0])}`,
    counts,
    titleParts,
    title: titleParts.map((part) => `${part.label}${part.value}`).join(" · "),
    intermediate,
    body,
    stages,
    finalMessage: finalIndex < 0 ? null : list[finalIndex],
    finalBlocks,
    messages: list,
  };
}

// 末尾那段还在进行的 run（没有任何切断分组的消息挡在它后面）：正在流式的消息就接在它后面。
const trailingProcessRun = (messages) => {
  const list = messages || [];
  let start = list.length;
  while (
    start > 0 &&
    (isProcessMessage(list[start - 1]) ||
      isSteeringMessage(list[start - 1]) ||
      (isOtherEntry(list[start - 1]) && otherSitsInTurn(list, start - 1)))
  )
    start -= 1;
  return start < list.length ? list.slice(start) : [];
};

/**
 * 按「轮是否结束」分流（用户 2026-09-25 选定）：还在进行的**那一整轮**从历史里摘出来，
 * 连同正在流式的消息交给 live 区一次算完 —— 正在生成的卡片因此住在它所属那一轮的
 * `<details>` 里，分组（只以「消息」划分）、级联折叠、轮次标题计数全部只有一份计算与一份 DOM。
 * 已结束的轮仍只依赖 messages，流式期间不会重算整段 transcript。
 *
 * 两边算出的 `group.key` 是同一个（都取这一段 run 首条消息的 id），所以轮次结束、整轮从 live 区
 * 移交回历史区时，折叠状态与级联水位线完全延续，不会跳一下。
 *
 * `hasPendingUser`（乐观用户消息已经代表新的一轮开始，但那条消息还没进 messages）时不摘尾，
 * 否则会把上一轮的尾巴错并进新轮；那条消息落库后自然对齐。
 */
export function splitRunningTail(
  messages,
  { running = false, hasPendingUser = false } = {},
) {
  const list = messages || [];
  if (!running || hasPendingUser) return { history: list, tail: [] };
  const run = trailingProcessRun(list);
  if (!run.length) return { history: list, tail: [] };
  return {
    history: list.slice(0, list.length - run.length),
    tail: run,
  };
}

// 把扁平的 messages 拆成可直接渲染的条目：单条消息，或一轮的折叠分组 + 它露出的最终输出。
// 引导送达的用户消息（`delivery: "steer"`）与**自动**压缩条目（`compactionSummary` 且非 manual）
// 归入当前分组：两者都发生在同一个 agent run 内部，所以既不切断分组，也不触发自动折叠，
// 只在分组标题里计入「引导`n`」/「压缩`n`」。手动压缩（`compactionReason: "manual"`）则是
// 普通条目：切断分组、单独渲染（切断但不触发折叠，与命令/通知同一规则）。
// 折叠时机（用户 2026-09-24 改口径）：`keepOpen` 只表示「这一轮正在进行」——进行中的那一轮
// 保持展开，本轮一结束（`running` 变假）立即折叠，不再等下一个用户输入开始。
// `collapseLoaded` / `nextUserInput` 仍在签名里但不再参与折叠判定：加载时 running 为假，
// 已加载的轮次自然全部收起；浏览器里尚未进入历史的乐观用户消息也不再提前折叠上一轮。
// groupMessages 只做纯计算，渲染与折叠状态由组件负责。
export function groupMessages(
  messages,
  { nextUserInput = false, collapseLoaded = false, running = false } = {},
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
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (
      isProcessMessage(message) ||
      isSteeringMessage(message) ||
      (isOtherEntry(message) && otherSitsInTurn(list, index))
    ) {
      // 中间过程（含引导消息、压缩条目，以及**夹在本轮过程之间的**「其他」条目）进 run
      // （归到本轮的折叠块），不切断分组、也不触发自动折叠。
      run.push(message);
      continue;
    }
    // 后面还有内容 = 这一轮已经结束了，一律折叠（用户 2026-09-24：本轮结束就折叠）。
    flush(false);
    items.push({ kind: "message", message });
  }
  // 末尾那一组：只有本轮还在进行才保持展开，本轮一结束立即折叠。
  flush(Boolean(running));
  return items;
}
