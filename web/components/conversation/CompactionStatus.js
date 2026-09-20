import { defineComponent, h, onUnmounted, ref } from "vue";
import ProcessingStatus, {
  formatFullTime,
  formatProcessingDuration,
} from "./ProcessingStatus.js";

/**
 * 压缩完成的单行文案：`压缩完成（耗时2分钟48秒）`（与助手侧徽标的耗时格式同一套）。
 */
export function compactionDoneText(durationMs) {
  return `压缩完成（耗时${formatProcessingDuration(durationMs)}）`;
}

/**
 * `/compact` 命令记录下方的压缩执行状态行（服务端挂在 `message.compaction` 上）：
 *
 * - **压缩进行中**（只有 `startedAt`）：复用 `ProcessingStatus` ——
 *   「正在压缩上下文...（x秒）」，hover 在**上方**弹「开始时间：完整时间戳」，
 *   与 live 区那条状态行完全同一套计时与浮层；
 * - **压缩完成**（带 `endedAt`）：「压缩完成（耗时2分钟48秒）」灰字一行，
 *   hover 弹开始/结束时间与总耗时（与助手侧完成徽标同一套浮层内容）。
 *
 * 起止时间都是服务端的钟：运行态不落盘（进程中途退出不会残留转不完的计时），
 * 完成状态随命令记录写进 `web-state.json`，刷新后照旧显示。
 */
export default defineComponent({
  name: "CompactionStatus",
  props: { compaction: { type: Object, default: null } },
  setup(props) {
    const open = ref(false);
    let hideTimer;
    // 延迟收起：鼠标从文字移到浮层途中有间隙，立刻收起会闪。
    const show = () => {
      clearTimeout(hideTimer);
      open.value = true;
    };
    const hide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => (open.value = false), 120);
    };
    onUnmounted(() => clearTimeout(hideTimer));
    return () => {
      const startedAt = Number(props.compaction?.startedAt);
      if (!Number.isFinite(startedAt)) return null;
      const endedAt = Number(props.compaction?.endedAt);
      // 还在压缩：整行交给 ProcessingStatus（同一个组件 = 同一套计时与浮层锚向）。
      if (!Number.isFinite(endedAt))
        return h(ProcessingStatus, { active: true, startedAt, compacting: true });
      const durationMs = Math.max(0, endedAt - startedAt);
      return h(
        "div",
        { class: "processing-status compaction-done" },
        h(
          "span",
          {
            class: "compaction-done-time",
            onMouseenter: show,
            onMouseleave: hide,
          },
          [
            compactionDoneText(durationMs),
            open.value
              ? h("span", { class: "status-tip", role: "tooltip" }, [
                  h("span", `开始时间：${formatFullTime(startedAt)}`),
                  h("span", `结束时间：${formatFullTime(endedAt)}`),
                  h("span", `总耗时：${formatProcessingDuration(durationMs)}`),
                ])
              : null,
          ],
        ),
      );
    };
  },
});
