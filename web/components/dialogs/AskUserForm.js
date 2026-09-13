import {
  computed,
  defineComponent,
  h,
  nextTick,
  onUnmounted,
  reactive,
  ref,
} from "vue";
import MarkdownContent from "../conversation/MarkdownContent.js";
import {
  normalizeAnswers,
  blankAnswer,
  answerText,
  serializeAnswers,
} from "./answers.js";

export default defineComponent({
  name: "AskUserForm",
  props: { request: { type: Object, required: true }, pending: Boolean },
  emits: ["submit"],
  setup(props, { emit }) {
    let saved;
    const storageKey = `ask-user:${props.request.id}`;
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey));
    } catch {}
    const host = ref(),
      state = reactive({
        tab: 0,
        collapsed: false,
        previews: new Set(),
        notes: new Set(),
        answers: normalizeAnswers(props.request.questions, saved?.answers),
      });
    for (const [index, answer] of state.answers.entries())
      if (answer.notes) state.notes.add(index);
    const review = computed(() => state.tab === props.request.questions.length);
    const save = () => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ answers: state.answers }),
        );
      } catch {}
    };
    let frame,
      disposed = false;
    const update = (change) => {
      const nodes = [
        document.scrollingElement,
        document.querySelector("#scroll"),
        document.querySelector("#plugin-requests"),
        host.value?.querySelector(".ask-content"),
      ];
      const positions = nodes.map(
        (node) => node && [node, node.scrollTop, node.scrollLeft],
      );
      change();
      save();
      const restore = () =>
        positions.forEach((position) => {
          if (position?.[0].isConnected) {
            position[0].scrollTop = position[1];
            position[0].scrollLeft = position[2];
          }
        });
      nextTick(() => {
        if (disposed) return;
        restore();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(restore);
      });
    };
    onUnmounted(() => {
      disposed = true;
      cancelAnimationFrame(frame);
    });
    const choose = (index) =>
      update(() => {
        const question = props.request.questions[state.tab],
          answer = state.answers[state.tab];
        if (question.multiSelect) {
          answer.kind = "multi";
          answer.options = answer.options.includes(index)
            ? answer.options.filter((i) => i !== index)
            : [...answer.options, index];
        } else {
          answer.kind = "option";
          answer.option = index;
          answer.custom = false;
        }
      });
    const custom = (text, checked = true) =>
      update(() => {
        const answer = state.answers[state.tab];
        answer.text = text;
        answer.custom = checked;
        answer.kind = props.request.questions[state.tab].multiSelect
          ? "multi"
          : "custom";
      });
    const send = (cancel) => {
      if (!props.pending)
        emit("submit", {
          id: props.request.id,
          draft: serializeAnswers(state.answers),
          cancel,
        });
    };
    const tab = (index) =>
      update(() => {
        state.tab = index;
      });
    const button = (label, attrs) =>
      h("button", { type: "button", disabled: props.pending, ...attrs }, label);
    return () => {
      const questions = props.request.questions,
        question = questions[state.tab],
        answer = state.answers[state.tab];
      const single = questions.length === 1;
      const children = [];
      if (!single)
        children.push(
          h("nav", { class: "ask-tabs" }, [
            ...questions.map((q, index) =>
              button(
                `${index + 1}. ${q.header}${state.answers[index].kind !== "unanswered" ? " ✓" : ""}`,
                {
                  key: index,
                  "data-ask-tab": index,
                  "aria-current": state.tab === index,
                  onClick: () => tab(index),
                },
              ),
            ),
            button("核对与提交", {
              "data-ask-tab": questions.length,
              "aria-current": review.value,
              onClick: () => tab(questions.length),
            }),
          ]),
        );
      if (review.value) {
        const missing = questions
          .filter((q, index) => state.answers[index].kind === "unanswered")
          .map((q) => q.header);
        children.push(
          h("h3", "核对答案"),
          ...questions.map((q, index) =>
            h("section", { key: index, class: "ask-review" }, [
              h("strong", q.header),
              h("div", answerText(q, state.answers[index])),
              state.answers[index].notes &&
                h("small", `备注：${state.answers[index].notes}`),
              button("修改", { onClick: () => tab(index) }),
            ]),
          ),
        );
        if (missing.length)
          children.push(
            h(
              "p",
              { class: "ask-warning" },
              `尚未回答：${missing.join("、")}。可返回补充，或仅提交已填写答案；备注本身不算作答。`,
            ),
          );
      } else {
        children.push(
          h("h3", question.question),
          h(
            "fieldset",
            {
              class: "choice-options",
              "aria-label": question.multiSelect ? "多选" : "单选",
              disabled: props.pending,
            },
            [
              ...question.options.map((option, index) => {
                const selected = question.multiSelect
                  ? answer.kind === "multi" && answer.options.includes(index)
                  : answer.kind === "option" && answer.option === index;
                const previewKey = `${state.tab}:${index}`;
                return h(
                  "div",
                  {
                    class: ["ask-option", { selected }],
                    key: `${state.tab}:${index}`,
                  },
                  [
                    h("label", [
                      h("input", {
                        type: question.multiSelect ? "checkbox" : "radio",
                        name: `answer-${props.request.id}`,
                        "data-ask-option": index,
                        checked: selected,
                        onChange: () => choose(index),
                      }),
                      h("span", [
                        h("strong", option.label),
                        h("small", option.description),
                      ]),
                    ]),
                    !question.multiSelect &&
                      option.preview &&
                      h(
                        "details",
                        {
                          class: "ask-preview",
                          open: state.previews.has(previewKey),
                          onToggle: (event) => {
                            if (event.target.open)
                              state.previews.add(previewKey);
                            else state.previews.delete(previewKey);
                          },
                        },
                        [
                          h("summary", `查看 ${option.label} 的预览`),
                          h(MarkdownContent, { text: option.preview }),
                        ],
                      ),
                  ],
                );
              }),
              h("div", { class: "ask-option ask-custom-option" }, [
                h("label", [
                  h("input", {
                    type: question.multiSelect ? "checkbox" : "radio",
                    name: `answer-${props.request.id}`,
                    "data-ask-custom": "",
                    checked: question.multiSelect
                      ? answer.kind === "multi" && answer.custom
                      : answer.kind === "custom",
                    onChange: (event) =>
                      custom(answer.text, event.target.checked),
                  }),
                  h("span", [
                    h("textarea", {
                      "data-ask-text": "",
                      rows: 2,
                      maxlength: 32000,
                      "aria-label": "自行填写",
                      value: answer.text,
                      placeholder: question.multiSelect
                        ? "输入其他回答，可与上方选项同时选择"
                        : "输入自己的回答，替代上方选项",
                      onFocus: () => custom(answer.text),
                      onInput: (event) => custom(event.target.value),
                    }),
                  ]),
                ]),
              ]),
            ],
          ),
          h("div", { class: "ask-extras" }, [
            h(
              "details",
              {
                open: state.notes.has(state.tab),
                onToggle: (event) => {
                  if (event.target.open) state.notes.add(state.tab);
                  else state.notes.delete(state.tab);
                },
              },
              [
                h("summary", `添加备注${answer.notes ? " · 已填写" : ""}`),
                h("label", { class: "ask-field" }, [
                  h("textarea", {
                    "data-ask-notes": "",
                    rows: 2,
                    maxlength: 32000,
                    disabled: props.pending,
                    "aria-label": "补充备注",
                    placeholder: "补充备注",
                    value: answer.notes,
                    onInput: (event) =>
                      update(() => {
                        answer.notes = event.target.value;
                      }),
                  }),
                ]),
              ],
            ),
          ]),
        );
      }
      return h(
        "div",
        {
          class: ["ask-user-form", { "ask-collapsed": state.collapsed }],
          "data-ask-id": props.request.id,
          ref: host,
        },
        [
          h("header", { class: "ask-header" }, [
            h("span", [
              h(
                "strong",
                { class: "ask-title" },
                review.value ? "核对答案" : question.header,
              ),
              !review.value &&
                h(
                  "span",
                  { class: "muted" },
                  ` ${state.tab + 1} / ${questions.length} · ${question.multiSelect ? "多选" : "单选"}`,
                ),
            ]),
            button(state.collapsed ? "展开" : "收起", {
              "data-ask-collapse": "",
              onClick: () =>
                update(() => {
                  state.collapsed = !state.collapsed;
                }),
            }),
          ]),
          h("div", { class: "ask-content" }, children),
          h("footer", { class: "ask-footer" }, [
            h("span", { class: "spacer" }),
            !review.value &&
              button("清除选择", {
                class: "ask-clear",
                "data-ask-clear": "",
                onClick: () =>
                  update(() => {
                    state.answers[state.tab] = {
                      ...blankAnswer(),
                      notes: answer.notes,
                    };
                  }),
              }),
            button("取消问卷", {
              "data-ask-cancel": "",
              onClick: () => send(true),
            }),
            !review.value &&
              state.tab > 0 &&
              button("上一题", { onClick: () => tab(state.tab - 1) }),
            review.value || single
              ? button("提交答案", {
                  class: "primary",
                  "data-ask-submit": "",
                  disabled:
                    props.pending || (single && answer?.kind === "unanswered"),
                  onClick: () => send(false),
                })
              : button(
                  state.tab + 1 === questions.length ? "核对答案" : "下一题",
                  { class: "primary", onClick: () => tab(state.tab + 1) },
                ),
          ]),
        ],
      );
    };
  },
});
