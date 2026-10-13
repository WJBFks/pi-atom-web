import {
  Teleport,
  defineComponent,
  h,
  onMounted,
  onScopeDispose,
  onUnmounted,
  ref,
  watch,
} from "vue";

/** 浮层与锚点之间的间距，与原先 CSS 里的 `calc(100% + 7px)` 一致。 */
const GAP = 7;

/**
 * 挂到 `document.body` 上的浮层（tooltip）。
 *
 * **为什么不留在原处**：消息正文里有三层吸顶标题（轮次标题 `z-index:20`、中间过程组 10、
 * 卡片标题 2），而折叠块基座是 `.disclosure-block{overflow:clip}`。行内浮层既要在这三层里
 * 比大小，又会被折叠块裁切（`#messages{isolation:isolate}` 把整段正文圈成一个堆叠上下文，
 * 光抬 z-index 治不好裁切），实测「轮次完成徽标的时间浮层」就被中间过程组的吸顶标题压住
 * （用户 2026-09-25 两次反馈）。传送到 body 后两个问题一起消除（图片预览同理，见 MessageItem）。
 *
 * 坐标取锚点矩形的**一次快照**（`position:fixed` + 视口坐标），所以展开期间一旦滚动或改窗口
 * 尺寸就 `emit("close")`，由调用方收起 —— 否则浮层会留在原地与锚点脱开。
 *
 * `placement`：`top` 在锚点上方，`bottom` 在下方；`align`：`start` 左缘对齐、`center` 水平居中、
 * `end` 右缘对齐。四个边都在内联样式里写死（含 `auto`），这样基础样式 `.status-tip` 不必再
 * 参与定位，也不会出现 `top`/`bottom` 同时生效把浮层拉长。
 */
export const PortalTip = defineComponent({
  name: "PortalTip",
  props: {
    anchor: { default: null },
    placement: { type: String, default: "top" },
    align: { type: String, default: "start" },
    extraClass: { type: String, default: "" },
  },
  emits: ["enter", "leave", "close"],
  setup(props, { slots, emit }) {
    const style = ref({});
    const place = () => {
      const rect = props.anchor?.getBoundingClientRect?.();
      if (!rect) {
        style.value = {};
        return;
      }
      const next = {
        position: "fixed",
        top: props.placement === "bottom" ? `${Math.round(rect.bottom + GAP)}px` : "auto",
        bottom:
          props.placement === "bottom" ? "auto" : `${Math.round(window.innerHeight - rect.top + GAP)}px`,
        right: props.align === "end" ? `${Math.round(window.innerWidth - rect.right)}px` : "auto",
        left: props.align === "end" ? "auto" : `${Math.round(props.align === "center" ? rect.left + rect.width / 2 : rect.left)}px`,
      };
      // 居中靠位移半个自身宽度：fixed 元素的包含块仍是视口，transform 不会改变它。
      if (props.align === "center") next.transform = "translateX(-50%)";
      style.value = next;
    };
    place();
    watch(() => props.anchor, place);
    const drop = () => emit("close");
    onMounted(() => {
      // 捕获阶段才收得到 `#scroll` 内部滚动。
      window.addEventListener("scroll", drop, true);
      window.addEventListener("resize", drop);
    });
    onUnmounted(() => {
      window.removeEventListener("scroll", drop, true);
      window.removeEventListener("resize", drop);
    });
    return () =>
      h(Teleport, { to: "body" }, [
        h(
          "span",
          {
            class: ["status-tip", "portal-tip", props.extraClass].filter(Boolean).join(" "),
            style: style.value,
            "data-placement": props.placement,
            role: "tooltip",
            // 浮层不再是锚点的子孙，鼠标移进浮层要靠这两个监听不收起。
            onMouseenter: () => emit("enter"),
            onMouseleave: () => emit("leave"),
          },
          slots.default?.(),
        ),
      ]);
  },
});

/**
 * hover 浮层的开合 + 定位：`anchor` 给触发元素当 `ref`，`show`/`hide` 挂 `onMouseenter`/
 * `onMouseleave`，`tip(内容, { placement, align, class })` 放在锚点原来放浮层的位置。
 * `delay` 保留原来的 120ms 延迟收起（锚点与浮层之间有 7px 间隙，立刻收起会闪）。
 */
export function useHoverTip(delay = 120) {
  const anchor = ref(null);
  const open = ref(false);
  let timer = null;
  const show = () => {
    clearTimeout(timer);
    open.value = true;
  };
  const hide = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (open.value = false), delay);
  };
  const drop = () => {
    clearTimeout(timer);
    open.value = false;
  };
  onScopeDispose(() => clearTimeout(timer));
  const tip = (content, options = {}) =>
    open.value && anchor.value
      ? h(
          PortalTip,
          {
            anchor: anchor.value,
            placement: options.placement ?? "top",
            align: options.align ?? "start",
            extraClass: options.class ?? "",
            onEnter: show,
            onLeave: hide,
            onClose: drop,
          },
          () => content,
        )
      : null;
  return { anchor, open, show, hide, drop, tip };
}
