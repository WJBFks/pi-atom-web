import { defineComponent, h } from "vue";

// 左上角的页面 tab（标题行下方）。当前只显示对话与设置。
// 执行轨迹与上下文页暂时隐藏（`hidden: true`）：视图代码与页面宿主都保留，
// 将来各自改为独立页面后去掉 hidden 即可接回，见 AGENTS.md「待办」。
export const VIEW_TABS = [
  { id: "chat", label: "对话", panel: "view-panel-feed" },
  {
    id: "trace",
    label: "轨迹",
    panel: "view-panel-feed",
    disabled: true,
    hidden: true,
    hint: "执行轨迹将改为独立页面",
  },
  { id: "context", label: "上下文", panel: "view-panel-context", hidden: true },
  { id: "settings", label: "设置", panel: "view-panel-settings" },
];

// 页面上真正渲染出来的 tab：暂时隐藏的条目既不显示，也不参与键盘切换。
export const VISIBLE_TABS = VIEW_TABS.filter((tab) => !tab.hidden);

// 纯函数：tablist 的键盘移动（左右循环、Home/End，跳过不可选中的 tab），
// 目标与当前相同时返回 null。
export function nextTab(view, key) {
  const enabled = VISIBLE_TABS.filter((tab) => !tab.disabled);
  const index = enabled.findIndex((tab) => tab.id === view);
  if (index < 0) return null;
  const move = (target) => {
    const next = (target + enabled.length) % enabled.length;
    return next === index ? null : enabled[next].id;
  };
  if (key === "ArrowRight") return move(index + 1);
  if (key === "ArrowLeft") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(enabled.length - 1);
  return null;
}

export default defineComponent({
  name: "ViewTabs",
  props: { view: String },
  emits: ["select"],
  setup(props, { emit }) {
    const onKeydown = (event) => {
      const next = nextTab(props.view, event.key);
      if (!next) return;
      event.preventDefault();
      emit("select", next);
      event.currentTarget
        ?.querySelector?.(`[data-view="${next}"]`)
        ?.focus?.();
    };
    return () =>
      h(
        "div",
        {
          class: "view-tabs",
          role: "tablist",
          "aria-label": "会话页面",
          onKeydown,
        },
        VISIBLE_TABS.map((tab) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              key: tab.id,
              id: `view-tab-${tab.id}`,
              "data-view": tab.id,
              "aria-selected": props.view === tab.id,
              "aria-controls": tab.panel,
              disabled: Boolean(tab.disabled),
              title: tab.hint || null,
              tabindex: props.view === tab.id ? 0 : -1,
              class: props.view === tab.id ? "active" : null,
              onClick: () => emit("select", tab.id),
            },
            tab.label,
          ),
        ),
      );
  },
});
