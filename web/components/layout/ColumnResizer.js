import { defineComponent, h, onMounted, onUnmounted, ref, shallowRef } from "vue";

export const DEFAULT_CONTENT_WIDTH = 860;
export const MIN_CONTENT_WIDTH = 520;
export const CONTENT_WIDTH_STORAGE_KEY = "atom-content-width";

// 视口两侧为内容列各预留的空隙（列使用 border-box，已含内边距）。
const VIEWPORT_GUTTER = 32;
// 热区只贴在文字区外侧：既不遮挡文本选择，又留出足够宽松的左右判定宽度。
const ZONE_WIDTH = 32;
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_FAST = 48;
const FALLBACK_TOOLBAR_HEIGHT = 59;
const FALLBACK_HANDLE_HEIGHT = 96;

export function maxContentWidth(available) {
  const value = Number(available);
  const width = Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTENT_WIDTH;
  return Math.max(DEFAULT_CONTENT_WIDTH, Math.round(width) - VIEWPORT_GUTTER);
}

export function clampContentWidth(value, available) {
  const wanted = Number(value);
  return Math.round(
    Math.min(
      Math.max(Number.isFinite(wanted) ? wanted : DEFAULT_CONTENT_WIDTH, MIN_CONTENT_WIDTH),
      maxContentWidth(available),
    ),
  );
}

export function readStoredContentWidth(storage = globalThis.localStorage) {
  try {
    const value = Number(storage?.getItem(CONTENT_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTENT_WIDTH;
  } catch {
    return DEFAULT_CONTENT_WIDTH;
  }
}

export function storeContentWidth(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CONTENT_WIDTH_STORAGE_KEY, String(Math.round(value)));
  } catch {
    /* 隐私模式或禁用存储时静默降级为不记忆 */
  }
}

// 内容列（#messages 与 .compose-wrap）左右边界的手柄：hover 时出现在鼠标高度，
// 拖动对称改变共享的 --content-width，双击恢复默认。
//
// 性能约束：拖动期间每个动画帧最多写一次变量、读一次几何、写一次样式。
// 环境读数（内边距、滚动容器宽度、dock 顶边、手柄高度）只在挂载与尺寸变化时缓存，
// 避免每个 pointermove 触发多次强制同步布局。
export default defineComponent({
  name: "ColumnResizer",
  setup() {
    const root = shallowRef(null);
    const zoneLeft = shallowRef(null);
    const zoneRight = shallowRef(null);
    const pill = shallowRef(null);
    const visible = ref(false);
    const active = ref(false);

    let listEl = null;
    let scrollEl = null;
    let toolbarEl = null;
    let env = null;
    let drag = null;
    let hoverSide = null;
    let pointerY = 0;
    let frame = 0;
    let observer;

    let desired = readStoredContentWidth();
    let applied = clampContentWidth(
      desired,
      typeof document === "undefined"
        ? DEFAULT_CONTENT_WIDTH
        : document.documentElement.clientWidth,
    );
    if (typeof document !== "undefined")
      document.documentElement.style.setProperty("--content-width", `${applied}px`);

    const mainElement = () => root.value?.parentElement || document.querySelector("main");

    const attach = (element, selector) =>
      element?.isConnected ? element : document.querySelector(selector);

    // 只在挂载、尺寸变化与拖动结束时刷新环境读数。
    function refresh() {
      const mainEl = mainElement();
      if (!mainEl) return false;
      listEl = attach(listEl, "#messages");
      scrollEl = attach(scrollEl, "#scroll");
      toolbarEl = attach(toolbarEl, ".toolbar");
      if (!listEl) return false;
      const style = getComputedStyle(listEl);
      env = {
        // #scroll 出滚动条时会缩窄，按它实际可用宽度限制内容列。
        available: scrollEl?.clientWidth || mainEl.clientWidth || DEFAULT_CONTENT_WIDTH,
        padLeft: parseFloat(style.paddingLeft) || 0,
        padRight: parseFloat(style.paddingRight) || 0,
        toolbarHeight: Math.round(
          toolbarEl ? toolbarEl.getBoundingClientRect().height : FALLBACK_TOOLBAR_HEIGHT,
        ),
        pillHeight: pill.value?.offsetHeight || FALLBACK_HANDLE_HEIGHT,
      };
      return true;
    }

    function draw() {
      if (!env && !refresh()) return;
      const mainEl = mainElement();
      if (!mainEl || !listEl) return;

      // 先写完宽度变量，再读几何：整帧只有一次强制布局。
      const width = clampContentWidth(desired, env.available);
      if (width !== applied) {
        applied = width;
        document.documentElement.style.setProperty("--content-width", `${width}px`);
      }
      const mainRect = mainEl.getBoundingClientRect();
      const listRect = listEl.getBoundingClientRect();
      const innerLeft = Math.round(listRect.left + env.padLeft - mainRect.left);
      const innerRight = Math.round(listRect.right - env.padRight - mainRect.left);
      const top = env.toolbarHeight;
      // 热区从工具栏下沿一直延伸到视口底部，覆盖下方输入框所在区域，
      // 因此在 dock 高度也能抓住内容列边界；两侧热区只占文字区之外的空隙。
      const height = Math.max(0, Math.round(mainRect.height) - top);
      const maximum = maxContentWidth(env.available);
      const value = String(applied);

      for (const [node, left] of [
        [zoneLeft.value, innerLeft - ZONE_WIDTH],
        [zoneRight.value, innerRight],
      ]) {
        if (!node) continue;
        node.style.width = `${ZONE_WIDTH}px`;
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
        node.style.height = `${height}px`;
        node.setAttribute("aria-valuemin", String(MIN_CONTENT_WIDTH));
        node.setAttribute("aria-valuemax", String(maximum));
        node.setAttribute("aria-valuenow", value);
      }

      const node = pill.value;
      if (!node) return;
      const side = drag?.side || hoverSide;
      if (!side) {
        if (visible.value) visible.value = false;
        return;
      }
      const x = side === "left" ? innerLeft - ZONE_WIDTH / 2 : innerRight + ZONE_WIDTH / 2;
      const half = env.pillHeight / 2;
      const minY = top + half;
      const maxY = Math.max(minY, top + height - half);
      const y = Math.min(Math.max(pointerY - mainRect.top, minY), maxY);
      node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
      if (!visible.value) visible.value = true;
    }

    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    }

    const clampDesired = (value) =>
      Math.min(
        Math.max(value, MIN_CONTENT_WIDTH),
        maxContentWidth(env?.available ?? DEFAULT_CONTENT_WIDTH),
      );

    function onEnter(event, side) {
      if (drag) return;
      hoverSide = side;
      pointerY = event.clientY;
      draw();
    }

    function onMove(event, side) {
      pointerY = event.clientY;
      if (drag) {
        // 两侧对称：鼠标位移 1px，总宽变化 2px。
        const delta = (event.clientX - drag.startX) * 2;
        desired = clampDesired(
          drag.side === "left" ? drag.startWidth - delta : drag.startWidth + delta,
        );
        schedule();
        return;
      }
      hoverSide = side;
      schedule();
    }

    function onLeave() {
      if (drag) return;
      hoverSide = null;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      draw();
    }

    function startDrag(event, side) {
      if (event.button !== 0 || drag) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* 指针捕获失败时仍可用普通拖动 */
      }
      drag = {
        side,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: applied,
      };
      hoverSide = side;
      pointerY = event.clientY;
      document.body.classList.add("is-resizing");
      active.value = true;
      draw();
    }

    function endDrag(event) {
      if (!drag) return;
      const { pointerId } = drag;
      drag = null;
      try {
        event?.currentTarget?.releasePointerCapture(pointerId);
      } catch {
        /* 指针已释放 */
      }
      document.body.classList.remove("is-resizing");
      active.value = false;
      commit(desired);
      if (!event?.currentTarget?.matches?.(":hover")) hoverSide = null;
      refresh();
      draw();
    }

    function onKeydown(event, side) {
      const step = event.shiftKey ? KEYBOARD_STEP_FAST : KEYBOARD_STEP;
      let delta = 0;
      if (event.key === "ArrowRight") delta = side === "right" ? step : -step;
      else if (event.key === "ArrowLeft") delta = side === "left" ? step : -step;
      else return;
      event.preventDefault();
      refresh();
      hoverSide = side;
      desired = clampDesired(readStoredContentWidth() + delta);
      commit(desired);
      draw();
    }

    function resetWidth() {
      desired = DEFAULT_CONTENT_WIDTH;
      commit(desired);
      draw();
    }

    // 自己改动宽度后广播一次，设置页据此同步显示；设置页的改动也用同一事件回来。
    const commit = (value) => {
      storeContentWidth(value);
      globalThis.dispatchEvent?.(
        new CustomEvent("atom-content-width", { detail: value }),
      );
    };
    const onExternalWidth = () => {
      desired = readStoredContentWidth();
      refresh();
      draw();
    };
    const onResize = () => {
      if (drag) return;
      refresh();
      draw();
    };

    onMounted(() => {
      refresh();
      draw();
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(onResize);
        for (const element of [mainElement(), toolbarEl])
          if (element) observer.observe(element);
      }
      window.addEventListener("resize", onResize);
      window.addEventListener("atom-content-width", onExternalWidth);
    });

    onUnmounted(() => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("atom-content-width", onExternalWidth);
      document.body.classList.remove("is-resizing");
      document.documentElement.style.removeProperty("--content-width");
    });

    const zone = (side, nodeRef) =>
      h("div", {
        class: "column-resizer-zone",
        ref: nodeRef,
        "data-side": side,
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": side === "left" ? "调整内容区宽度（左侧）" : "调整内容区宽度（右侧）",
        tabindex: "0",
        onPointerenter: (event) => onEnter(event, side),
        onPointermove: (event) => onMove(event, side),
        onPointerleave: onLeave,
        onPointerdown: (event) => startDrag(event, side),
        onPointerup: endDrag,
        onPointercancel: endDrag,
        onDblclick: resetWidth,
        onKeydown: (event) => onKeydown(event, side),
      });

    return () =>
      h("div", { class: "column-resizer", ref: root }, [
        zone("left", zoneLeft),
        zone("right", zoneRight),
        h("div", {
          class: {
            "column-resizer-handle": true,
            "is-visible": visible.value,
            "is-active": active.value,
          },
          ref: pill,
          "aria-hidden": "true",
        }),
      ]);
  },
});
