import { computed, defineComponent, h } from "vue";
import { icon, thinkingIcon } from "../../icons.js";
import ModelPicker from "./ModelPicker.js";

const labels = {
  off: "关闭",
  minimal: "minimal",
  minimum: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * 模型 + 思考级别的合并面板（用户 2026-09-25 给了两张图，要求把原来两个按钮合成一个）：
 * - 顶行是**当前模型名**，点它在同一个面板里切到「供应方 + 模型」两栏视图，左上角出现「返回」；
 * - 中间是当前级别：`[仪表图标] 思考级别 · medium`；
 * - 底部是一根滑块，档位就是后端下发的 `thinkingLevels`（不是固定七档），拖动即下发、面板不关。
 * 原来那版七行列表（ThinkingPicker）已删掉，仪表图标改挂在滑块左边的当前级别上。
 */
export default defineComponent({
  name: "ModelThinkingPicker",
  props: {
    modelName: String,
    levels: { type: Array, default: () => [] },
    thinking: String,
    // 忙碌时排队的待生效值：有值就在面板里说明「本轮结束后自动切换」。
    pendingThinking: String,
    busy: Boolean,
    models: { type: Array, default: () => [] },
    selected: Object,
    provider: String,
    query: String,
    // 当前视图由外面给（存 composer store）：`/model` 命令需要直接落在模型视图上。
    tab: String,
    chooseTab: Function,
    chooseProvider: Function,
    updateQuery: Function,
    chooseModel: Function,
    chooseThinking: Function,
  },
  setup(props) {
    // 面板内两个视图："levels"（思考级别）与 "model"（供应方 + 模型）。
    // 合并按钮只有一层弹层，靠它切换而不是关掉重开（用户选定「面板内切换 + 返回」）。
    const view = computed(() => (props.tab === "model" ? "model" : "levels"));
    const openTab = (value) => props.chooseTab?.(value);
    const level = computed(() => props.pendingThinking || props.thinking || "off");
    const index = computed(() => {
      const at = props.levels.indexOf(level.value);
      return at < 0 ? 0 : at;
    });
    const stepTo = async (event) => {
      const at = Number(event.target.value);
      const next = props.levels[at];
      if (!next || next === level.value) return;
      // 拖动即下发、面板不关（用户选定）。下发失败时把滑块拨回真正生效的那一档：
      // Vue 只在 vnode 的 value 变了才会写回 DOM，而失败时它根本没变，不手动回就停在假位置。
      if ((await props.chooseThinking?.(next)) === false)
        event.target.value = String(index.value);
    };
    // 选完模型（包含排队等空闲的情况）回到级别视图，看到的就是新的「模型 + 级别」组合。
    const pickModel = async (model) => {
      const ok = await props.chooseModel?.(model);
      if (ok !== false) openTab("levels");
    };
    return () =>
      h(
        "div",
        {
          id: "model-thinking-picker",
          class: [
            "setting-picker",
            "model-thinking",
            { "is-model": view.value === "model" },
          ],
          role: "dialog",
          "aria-label": "模型与思考级别",
        },
        view.value === "model"
          ? [
              h("div", { class: "mtp-head" }, [
                h(
                  "button",
                  {
                    class: "mtp-back",
                    type: "button",
                    onClick: () => openTab("levels"),
                  },
                  [icon("chevron-left"), "返回"],
                ),
                h("strong", "选择模型"),
              ]),
              h(ModelPicker, {
                embedded: true,
                models: props.models,
                selected: props.selected,
                provider: props.provider,
                query: props.query,
                chooseProvider: props.chooseProvider,
                updateQuery: props.updateQuery,
                chooseModel: pickModel,
              }),
            ]
          : [
              h(
                "button",
                {
                  class: "mtp-model",
                  type: "button",
                  "data-model-row": "true",
                  onClick: () => openTab("model"),
                },
                [
                  h("span", { class: "picker-label" }, props.modelName),
                  h("span", { class: "picker-check" }, icon("chevron-right")),
                ],
              ),
              h("div", { class: "mtp-level" }, [
                thinkingIcon(level.value),
                h(
                  "span",
                  `思考级别 · ${labels[level.value] || level.value}`,
                ),
              ]),
              props.levels.length > 1
                ? h("div", { class: "mtp-slider" }, [
                    h("input", {
                      class: "mtp-range",
                      type: "range",
                      min: 0,
                      max: props.levels.length - 1,
                      step: 1,
                      value: index.value,
                      "aria-label": "思考级别",
                      "aria-valuetext": labels[level.value] || level.value,
                      onInput: stepTo,
                    }),
                    // 刻度点：左右各内缩半个滑块宽度（8px），于是每个点正好落在滑块的中心上。
                    h(
                      "div",
                      { class: "mtp-ticks", "aria-hidden": "true" },
                      props.levels.map((item, at) =>
                        h("span", {
                          key: item,
                          class: { active: at <= index.value },
                        }),
                      ),
                    ),
                  ])
                : h(
                    "div",
                    { class: "mtp-pending" },
                    "当前模型只有一个思考级别，无需选择。",
                  ),
              props.busy && props.pendingThinking
                ? h(
                    "div",
                    { class: "mtp-pending" },
                    `处理中，本轮结束后自动切到 ${labels[props.pendingThinking] || props.pendingThinking}。`,
                  )
                : null,
            ],
      );
  },
});
