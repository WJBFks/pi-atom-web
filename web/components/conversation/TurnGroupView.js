import { h } from "vue";
import { messageId } from "../../stores/conversation.js";
import TurnGroup from "./TurnGroup.js";
import TurnStage from "./TurnStage.js";

/**
 * 渲染一个轮次分组：`轮次标题 → 组1 / 消息1 / 组2 / …`（组外的最终输出由调用方自己渲染）。
 *
 * **历史区与 live 区共用**（用户 2026-09-25 定的按轮分流）：还在进行的那一整轮由 live 区渲染、
 * 已结束的轮由历史区渲染，同一轮不会在两个容器里各出一份 DOM。两边共用同一份渲染逻辑，
 * 也保证移交（轮次结束、从 live 区回到历史区）时 DOM 形状完全一致。
 *
 * `renderUnit(unit, key, withStatus, extraClass)` 由调用方决定单条消息怎么渲染：
 * 历史用 `historyTools` 与轮次状态徽标，live 用实时工具上下文且不挂徽标。
 */
export function renderTurnGroup(group, { keepOpen = false, renderUnit, turnProps = {} }) {
  // 中断轮次没有组外最终输出（整轮都在组内），徽标改挂在组内最后一条 assistant 上；
  // 正常轮次的徽标挂在组外最终输出上，组内一律不挂，否则会重复。
  let lastAssistantId = null;
  if (!group.finalMessage) {
    for (let i = group.messages.length - 1; i >= 0; i -= 1) {
      if (group.messages[i]?.role === "assistant") {
        lastAssistantId = messageId(group.messages[i]);
        break;
      }
    }
  }
  const body = group.body || [];
  return h(
    TurnGroup,
    {
      key: group.key,
      blockKey: group.key,
      title: group.title,
      titleParts: group.titleParts,
      keepOpen,
      // 调用方额外标记（live 区给 `.turn-live`，CSS 靠它补上容器与下方内容的 8px 间距）。
      ...turnProps,
    },
    {
      default: () =>
        body.map((item, position) => {
          const edge =
            position === 0
              ? "turn-head"
              : position === body.length - 1
                ? "turn-tail"
                : "";
          if (item.kind === "text")
            return renderUnit(
              item.unit,
              `${group.key}:text-${position}`,
              false,
              edge,
            );
          const stage = item.stage;
          return h(
            TurnStage,
            {
              key: stage.key,
              blockKey: stage.key,
              title: stage.title,
              titleParts: stage.titleParts,
              class: edge || undefined,
            },
            {
              default: () =>
                stage.items.map((unit, inner) =>
                  renderUnit(
                    unit,
                    `${stage.key}:${inner}`,
                    messageId(unit.message) === lastAssistantId,
                    inner === stage.items.length - 1 ? "turn-tail" : "",
                  ),
                ),
            },
          );
        }),
    },
  );
}
