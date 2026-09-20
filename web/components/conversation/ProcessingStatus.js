import {
  defineComponent,
  h,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { icon } from "../../icons.js";

/**
 * 带 hover 文字浮层的图标按钮：按钮 + 自绘浮层（不用系统 `title`——样式不可控且有延迟）。
 * `placement`：`"top"` 显示在按钮**上方**（消息内的状态行用它，避免压住下方正文）；
 * `"bottom"` 显示在按钮下方。鼠标在按钮与浮层之间移动时靠 120ms 延迟收起衔接，
 * 因此浮层不会"一移开按钮就消失"。
 */
export const IconTipButton = defineComponent({
  name: "IconTipButton",
  // 关掉自动 attrs 继承：否则 `class`/`onClick` 会被同时落到根 span 与按钮本体上
  // （点击按钮再冒泡到 span 会触发第二次，`class` 也会在外壳与本体各生效一次）。
  inheritAttrs: false,
  props: {
    iconName: { type: String, default: "" },
    label: { type: String, required: true },
    placement: { type: String, default: "bottom" },
    disabled: Boolean,
  },
  setup(props, { slots, attrs }) {
    const open = ref(false);
    let tipTimer;
    // 继承来的 class（如 `.user-prompt-action`）显式给外壳：尺寸/圆角/透明度都作用在外壳上，
    // 按钮本体只保留 `.tip-button-control`，避免两类同时生效导致 padding/border 叠加或透明度翻倍。
    const { class: inheritedClass, ...buttonAttrs } = attrs;
    const show = () => {
      clearTimeout(tipTimer);
      open.value = true;
    };
    const hide = () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => (open.value = false), 120);
    };
    onUnmounted(() => clearTimeout(tipTimer));
    return () =>
      h(
        "span",
        { class: ["tip-button", inheritedClass], onMouseenter: show, onMouseleave: hide },
        [
          h(
            "button",
            {
              type: "button",
              class: "tip-button-control",
              disabled: props.disabled,
              "aria-label": props.label,
              ...buttonAttrs,
            },
            slots.default ? slots.default() : icon(props.iconName),
          ),
          open.value && !props.disabled
            ? h(
                "span",
                {
                  class: "status-tip tip-button-tip",
                  "data-placement": props.placement,
                  role: "tooltip",
                },
                props.label,
              )
            : null,
        ],
      );
  },
});

/**
 * 把毫秒格式化成「XX分钟YY秒」。
 * 不足 1 分钟只显示秒（`12秒`），便于一眼看出刚提交。
 */
export function formatProcessingDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分钟${seconds}秒` : `${seconds}秒`;
}

const pad = (value) => String(value).padStart(2, "0");

/** `2026/09/18 17:07:17` —— hover 浮层里的完整时间戳（运行态与完成徽标共用）。 */
export function formatFullTime(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 取消息里**最后一块**的类型；没有 content 时返回 null。
 */
export function lastBlockType(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return blocks[blocks.length - 1]?.type || null;
}

/**
 * 按优先级推导当前状态文案。
 *
 * 优先级（高 → 低）：
 *   1. 被活动组件阻塞   —— 会话完全动不了，必须先处理
 *   2. 正在调用 X 工具   —— 有工具在跑
 *   3. 正在思考          —— 正在流式输出 thinking
 *   4. 正在等待模型响应  —— 已提交尚无输出，或刚跑完工具、模型还没开始出字
 *   5. 正在处理          —— 兜底（正在流式输出正文等）
 *
 * `waitingModel` 由调用方判定：**没有在流式输出、也没有工具在跑，但会话仍在工作**，
 * 包括「刚调用完工具、等模型基于工具结果继续」这一段。
 */
export function processingLabel(state) {
  const { blockedNames, runningTool, thinking, compacting, waitingModel } = state;
  if (blockedNames.length) return `被${blockedNames}活动组件阻塞...`;
  if (runningTool) return `正在调用${runningTool}工具...`;
  if (thinking) return "正在思考...";
  if (compacting) return "正在压缩上下文...";
  if (waitingModel) return "正在等待模型响应...";
  return "正在处理...";
}

/**
 * 阻塞文案：1 个用名称、2 个用「A和B」、3 个及以上用「A、B等共N个活动」。
 * 名称包成行内代码（与活动栏 tab 的名字一致）。
 */
export function blockedLabelParts(names) {
  const code = (name) => ({ code: name });
  if (names.length === 1) return ["被", code(names[0]), "活动组件阻塞..."];
  if (names.length === 2)
    return ["被", code(names[0]), "和", code(names[1]), "活动组件阻塞..."];
  return [
    "被",
    code(names[0]),
    "、",
    code(names[1]),
    `等共${names.length}个活动组件阻塞...`,
  ];
}

/**
 * 当前正在跑的那一轮的执行状态：按需显示丰富信息 + 实时计时。
 *
 * 「处理时间 = 当前时间 − 任务开始时间」，起点由服务端给出（`processingStartedAt`：
 * prompt 被宿主接管的那一刻，跨越整轮，只在整轮结束时清空），前端不自己记起点 ——
 * 否则页面刷新/重连后计时会从 0 重来。
 *
 * 注意：**已结束的轮次不在这里显示**。每轮的「已完成（时长）」/「已中断（时长）」
 * 由 MessageItem 依据服务端落盘的 `turnProcessing` 渲染在该轮最后一条消息的
 * <article class="message"> 内（`.body` 的兄弟节点），刷新后依旧显示。
 */
export default defineComponent({
  name: "ProcessingStatus",
  props: {
    active: { type: Boolean, required: true },
    /** 任务开始时间（毫秒时间戳）；为空表示还没开始，不显示计时。 */
    startedAt: { type: Number, default: null },
    /** 阻塞的活动组件名（可为空数组）。 */
    blockedNames: { type: Array, default: () => [] },
    /** 正在运行的工具名（已本地化，如「读取」「编辑」）。 */
    runningTool: { type: String, default: "" },
    /** 正在流式输出 thinking。 */
    thinking: { type: Boolean, default: false },
    /** 正在压缩上下文（auto / manual）。压缩期间不显示为「等待模型响应」。 */
    compacting: { type: Boolean, default: false },
    /** 在等模型响应（已提交尚无输出，或刚跑完工具等模型继续）。 */
    waitingModel: { type: Boolean, default: false },
  },
  setup(props) {
    const now = shallowRef(Date.now());
    const tipOpen = ref(false);
    let timer, tipTimer;

    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const showTip = () => {
      clearTimeout(tipTimer);
      tipOpen.value = true;
    };
    const hideTip = () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => (tipOpen.value = false), 120);
    };
    // 只有「在跑」才需要每秒 tick；否则（阻塞等静态状态）不需要计时器。
    const sync = () => {
      if (props.active && props.startedAt != null) {
        now.value = Date.now();
        if (!timer)
          timer = setInterval(() => {
            now.value = Date.now();
          }, 1000);
      } else {
        stop();
      }
    };

    watch(() => [props.active, props.startedAt], sync, { immediate: true });
    onUnmounted(() => {
      stop();
      clearTimeout(tipTimer);
    });

    return () => {
      if (!props.active) return null;
      // 还没拿到起点（prompt 尚未被接管）：显示状态但不带计时（也没有 hover 浮层）。
      const duration =
        props.startedAt == null
          ? ""
          : `（${formatProcessingDuration(now.value - props.startedAt)}）`;
      const blocked = props.blockedNames.length > 0;
      const label = blocked
        ? blockedLabelParts(props.blockedNames)
        : [
            processingLabel({
              blockedNames: [],
              runningTool: props.runningTool,
              thinking: props.thinking,
              compacting: props.compacting,
              waitingModel: props.waitingModel,
            }),
          ];
      return h(
        "div",
        {
          class: "processing-status",
          role: "status",
          "aria-live": "polite",
          onMouseenter: props.startedAt != null ? showTip : undefined,
          onMouseleave: props.startedAt != null ? hideTip : undefined,
        },
        [
          ...label.map((part) =>
            typeof part === "string" ? part : h("code", part.code),
          ),
          duration,
          // hover 浮层：只展示开始时间（完整时间戳）。
          props.startedAt != null && tipOpen.value
            ? h("span", { class: "status-tip", role: "tooltip" }, [
                h("span", `开始时间：${formatFullTime(props.startedAt)}`),
              ])
            : null,
        ],
      );
    };
  },
});
