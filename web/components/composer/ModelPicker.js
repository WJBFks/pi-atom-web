import { computed, defineComponent, h } from "vue";
import { icon } from "../../icons.js";

export default defineComponent({
  name: "ModelPicker",
  props: {
    models: { type: Array, default: () => [] },
    selected: Object,
    provider: String,
    query: String,
    // 内嵌到合并面板里时：不再自己定位/画框，只当一块内容用。
    embedded: Boolean,
    chooseProvider: Function,
    updateQuery: Function,
    chooseModel: Function,
  },
  setup(props) {
    const providers = computed(() => [
      ...new Map(
        props.models.map((model) => [
          model.provider,
          model.providerName || model.provider,
        ]),
      ).entries(),
    ]);
    const visible = computed(() =>
      props.models.filter(
        (model) =>
          (!props.provider || model.provider === props.provider) &&
          (!props.query ||
            `${model.name} ${model.id}`
              .toLowerCase()
              .includes(props.query.toLowerCase())),
      ),
    );
    const selected = (model) =>
      props.selected?.provider === model.provider &&
      props.selected?.id === model.id;
    const modelButton = (model) =>
      h(
        "button",
        {
          key: `${model.provider}:${model.id}`,
          type: "button",
          "data-provider-id": model.provider,
          "data-model-id": model.id,
          class: { selected: selected(model) },
          // 不再因为忙碌而禁用：忙碌时的选择由外面排队到空闲（用户 2026-09-25）。
          onClick: () => props.chooseModel?.(model),
        },
        // 选中勾放右边（用户 2026-09-25：供应方/模型/思考级别三处的勾全改到右边）。
        [
          h("span", { class: "picker-label" }, model.name),
          selected(model) &&
            h("span", { class: "picker-check" }, icon("check")),
        ],
      );
    return () =>
      h(
        "div",
        {
          id: "model-picker",
          class: [
            "setting-picker",
            { embedded: props.embedded, "model-picker": true },
          ],
          role: "dialog",
          "aria-label": "选择模型",
        },
        [
          h("div", { class: "model-providers" }, [
            h("strong", "选择供应方"),
            ...providers.value.map(([id, name]) =>
              h(
                "button",
                {
                  key: id,
                  type: "button",
                  "data-provider": id,
                  class: { selected: props.provider === id },
                  onClick: () => props.chooseProvider?.(id),
                },
                [
                  h("span", { class: "picker-label" }, name),
                  props.provider === id &&
                    h("span", { class: "picker-check" }, icon("check")),
                ],
              ),
            ),
            h(
              "button",
              {
                type: "button",
                "data-provider": "",
                class: ["show-all", { selected: !props.provider }],
                onClick: () => props.chooseProvider?.(null),
              },
              [
                h("span", { class: "picker-label" }, "显示全部"),
                !props.provider &&
                  h("span", { class: "picker-check" }, icon("check")),
              ],
            ),
          ]),
          h("div", { class: "model-list" }, [
            h(
              "strong",
              props.provider
                ? providers.value.find(([id]) => id === props.provider)?.[1] ||
                    props.provider
                : "全部模型",
            ),
            h("input", {
              id: "model-filter",
              value: props.query,
              placeholder: "筛选模型...",
              "aria-label": "筛选模型",
              onInput: (event) => props.updateQuery?.(event.target.value),
            }),
            h(
              "div",
              { class: "model-options-scroll" },
              visible.value.length
                ? props.provider
                  ? visible.value.map(modelButton)
                  : providers.value.flatMap(([id, name]) => {
                      const models = visible.value.filter(
                        (model) => model.provider === id,
                      );
                      return models.length
                        ? [
                            h(
                              "div",
                              {
                                key: `heading:${id}`,
                                class: "model-provider-heading",
                              },
                              name,
                            ),
                            ...models.map(modelButton),
                          ]
                        : [];
                    })
                : h("p", { class: "muted" }, "没有匹配模型"),
            ),
          ]),
        ],
      );
  },
});
