import { defineComponent, h } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import DisclosureBlock from "./DisclosureBlock.js";
import { provideCascade } from "./cascade.js";

/**
 * 中间过程组（用户 2026-09-24）：轮次分组内部再分一层折叠。
 *
 * 结构：`轮次标题 → 组1 / 消息1 / 组2 / 消息2 / 组3`，「消息」（正文输出块）平铺在组之间、
 * 不进折叠块；最终输出仍在轮次分组外面。
 *
 * 开合（用户 2026-09-24 改口径）：**一律默认折叠**，包括正在生成的那一组（活跃的中间过程
 * 卡片与已完成的完全一致，并不特殊）；开始与完成都不会改变它的开合。用户手动开合过就以
 * 记录为准 —— 这里用 `remember:true` 直接落盘（组很多，逐个手动开合后刷新还得在）。
 * 手动折叠本组会级联收起组内的卡片；反过来展开本组不会恢复它们此前的展开状态。
 * 标题与轮次标题同格式（`思考3 · 工具调用2`，数量是行内代码徽片），只算本组内容；
 * 左侧挂类型图标 `layers`，折叠时显示图标、悬停换成向右三角、展开时是向下三角 ——
 * 与中间过程卡片完全同一套规则（靠 DisclosureBlock 的 `.disclosure-icon` 与
 * `.disclosure-block:not(.turn-group)` 的 opacity 切换，不另写一份）。
 */
export default defineComponent({
  name: "TurnStage",
  props: {
    blockKey: { type: String, required: true },
    title: String,
    titleParts: Array,
  },
  setup(props, { slots }) {
    const settings = useSettingsStore();
    // 级联：本组被手动收起时，组内所有卡片一并收起（见 cascade.js）。
    provideCascade(props.blockKey);
    return () =>
      h(
        DisclosureBlock,
        {
          class: "turn-stage",
          blockKey: props.blockKey,
          // 类型图标：折叠时是它，hover 换成待展开的向右三角，展开时是向下三角。
          icon: "layers",
          // 关闭「自动折叠中间过程」时整片默认展开（用户手动收起仍然优先）。
          defaultOpen: !settings.autoCollapse,
        },
        {
          summary: () => {
            const parts = props.titleParts || [];
            if (!parts.length)
              return h("span", { class: "turn-title" }, props.title || "");
            const counts = [];
            parts.forEach((part, index) => {
              if (index)
                counts.push(
                  h(
                    "span",
                    { class: "turn-title-separator", key: `s${index}` },
                    "·",
                  ),
                );
              counts.push(
                h(
                  "span",
                  { class: "turn-count", key: `${part.label}${index}` },
                  [part.label, h("code", String(part.value))],
                ),
              );
            });
            return h("span", { class: "turn-title" }, counts);
          },
          default: () => slots.default?.(),
        },
      );
  },
});
