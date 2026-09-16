import {
  computed,
  defineComponent,
  h,
  nextTick,
  onUnmounted,
  reactive,
  ref,
} from "vue";
import MarkdownContent from "../../../components/conversation/MarkdownContent.js";
import {
  normalizeAnswers,
  blankAnswer,
  answerText,
  serializeAnswers,
  sanitizeQuestions,
  isAnswered,
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
    const questions = sanitizeQuestions(props.request.questions);
    const host = ref(),
      state = reactive({
        tab: 0,
        collapsed: false,
        previews: new Set(),
        notes: new Set(),
        answers: normalizeAnswers(questions, saved?.answers),
        globalNote:
          typeof saved?.globalNote === "string"
            ? saved.globalNote.slice(0, 32000)
            : "",
      });
    for (const [index, answer] of state.answers.entries())
      if (answer.notes) state.notes.add(index);
    const review = computed(() => state.tab === questions.length);
    const save = () => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            answers: state.answers,
            globalNote: state.globalNote,
          }),
        );
      } catch {}
    };
    let frame,
      disposed = false;
    const update = (change) => {
      // 扩展请求已并入活动组件栏，滚动位置只需保留页面与对话区（以及本表单内容区）
      const nodes = [
        document.scrollingElement,
        document.querySelector("#scroll"),
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
        const question = questions[state.tab],
          answer = state.answers[state.tab];
        if (question.multiSelect) {
          // 勾选与自由文本是**两个独立的存储**（宿主 `multiSelectChecked` /
          // `customDraftsByTab`）：勾选/取消勾选都不清空已输入的自由文本，
          // 也不改变它的勾选态；两者可共存。
          answer.options = answer.options.includes(index)
            ? answer.options.filter((i) => i !== index)
            : [...answer.options, index];
          answer.kind = "multi";
          // 绝不碰 `custom`：自由文本行自己的勾选态独立于其它选项，
          // 勾选/取消任何普通选项都不能改变它（也不能由 text 反推）。
        } else {
          answer.kind = "option";
          answer.option = index;
          answer.custom = false;
          answer.text = "";
        }
      });
    const custom = (text, checked = true) =>
      update(() => {
        const question = questions[state.tab];
        const answer = state.answers[state.tab];
        answer.text = text;
        answer.custom = checked;
        // 多选题的 kind 恒为 `multi`：自由文本由 `text` 携带，提交时并入 selected。
        // 单选题的自由回答是独立的答案类型（`custom`），绝不能写成 `multi`，
        // 否则 result.ts 会按「多选题」校验并报「无效多选答案」。
        if (question.multiSelect) {
          answer.kind = "multi";
          return;
        }
        answer.kind = checked ? "custom" : "unanswered";
      });
    const send = (cancel) => {
      if (!props.pending)
        emit("submit", {
          id: props.request.id,
          draft: serializeAnswers(state.answers),
          globalNote: state.globalNote,
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
      const question = questions[state.tab],
        answer = state.answers[state.tab];
      // 空/超界的请求（sanitize 后仍为空）与越界 tab 都回退到提示；核对页没有当前题
      if (!questions.length || (!review.value && (!question || !answer)))
        return h(
          "div",
          { class: "ask-user-form", "data-ask-id": props.request.id, ref: host },
          [
            h("header", { class: "ask-header" }, [
              h("span", [h("strong", { class: "ask-title" }, "无法渲染问卷")]),
            ]),
            h("div", { class: "ask-content" }, [
              h(
                "p",
                { class: "ask-warning" },
                "该请求的问卷格式不受支持，可在 TUI 中完成。",
              ),
            ]),
            h("footer", { class: "ask-footer" }, [
              h("span", { class: "spacer" }),
              button("取消问卷", {
                "data-ask-cancel": "",
                onClick: () => send(true),
              }),
            ]),
          ],
        );
      const single = questions.length === 1;
      const children = [];
      if (!single)
        children.push(
          h("nav", { class: "ask-tabs" }, [
            ...questions.map((q, index) =>
              button(
                `${index + 1}. ${q.header}${isAnswered(q, state.answers[index]) ? " ✓" : ""}`,
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
          .filter((q, index) => !isAnswered(q, state.answers[index]))
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
        children.push(
          h("label", { class: "ask-global-note" }, [
            h("span", "全局备注"),
            h("textarea", {
              rows: 2,
              maxlength: 32000,
              disabled: props.pending,
              "data-ask-global-note": "",
              "aria-label": "全局备注",
              placeholder: "为整个问卷添加备注（可选）",
              value: state.globalNote,
              onInput: (event) =>
                update(() => {
                  state.globalNote = event.target.value;
                }),
            }),
          ]),
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
                          // preview 是 Markdown，但契约要求多行文本按行渲染，
                          // 因此开启硬换行（否则 ASCII 布局会被折叠成一行）
                          h(MarkdownContent, { text: option.preview, breaks: true }),
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
                    // 多选下自由文本有自己独立的勾选态 `custom`，不能被其它
                    // 选项的勾选影响（单选仍是「选中即替代选项」的语义）。
                    checked: question.multiSelect
                      ? answer.custom
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
                        ? "输入其他回答，可与上方已选选项一起提交"
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
          ]),
          h("div", { class: "ask-content" }, children),
          h("footer", { class: "ask-footer" }, [
            // 「取消问卷」放在最左（不再用 spacer 把按钮推到右侧）
            button("取消问卷", {
              "data-ask-cancel": "",
              onClick: () => send(true),
            }),
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
            !review.value &&
              state.tab > 0 &&
              button("上一题", { onClick: () => tab(state.tab - 1) }),
            review.value || single
              ? button("提交答案", {
                  class: "primary",
                  "data-ask-submit": "",
                  disabled:
                    props.pending || (single && !isAnswered(question, answer)),
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
