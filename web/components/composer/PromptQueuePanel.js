import { defineComponent, h, shallowRef } from "vue";
import { postAction } from "../../api/actions.js";
import { icon } from "../../icons.js";
import { useSessionStore } from "../../stores/session.js";

export default defineComponent({
  name: "PromptQueuePanel",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore();
    const changing = shallowRef(null);
    const editing = shallowRef(null);
    const editDraft = shallowRef("");
    const request = (action) =>
      postAction(props.token, { ...action, sessionId: session.sessionId });

    const mutate = async (item, kind, text = item.text) => {
      if (changing.value) return false;
      changing.value = item.id;
      try {
        await request({
          type: "queue_update_item",
          id: item.id,
          revision: session.promptQueue.revision,
          kind,
          text,
        });
        editing.value = null;
        editDraft.value = "";
        return true;
      } catch (error) {
        props.onError?.(error);
        return false;
      } finally {
        changing.value = null;
      }
    };
    const remove = async (item) => {
      if (changing.value) return;
      changing.value = item.id;
      try {
        await request({
          type: "queue_remove",
          id: item.id,
          revision: session.promptQueue.revision,
        });
        if (editing.value === item.id) editing.value = null;
      } catch (error) {
        props.onError?.(error);
      } finally {
        changing.value = null;
      }
    };
    const beginEdit = (item) => {
      editing.value = item.id;
      editDraft.value = item.text;
    };
    const cancelEdit = () => {
      editing.value = null;
      editDraft.value = "";
    };
    const actionButton = (label, handler, options = {}) =>
      h(
        "button",
        {
          type: "button",
          class: options.class,
          disabled: options.disabled,
          "aria-label": options.ariaLabel || label,
          title: options.title || label,
          onClick: handler,
        },
        options.icon ? icon(options.icon) : label,
      );
    const editRow = (item) =>
      h("div", { class: "prompt-queue-editor" }, [
        h("textarea", {
          rows: 2,
          value: editDraft.value,
          "aria-label": "编辑排队消息",
          onInput: (event) => (editDraft.value = event.target.value),
          onKeydown: (event) => {
            if (event.key === "Escape") cancelEdit();
          },
        }),
        h("div", { class: "prompt-queue-editor-actions" }, [
          actionButton("取消", cancelEdit, { disabled: !!changing.value }),
          actionButton("保存为排队", () => mutate(item, "followUp", editDraft.value.trim()), {
            disabled: !!changing.value || !editDraft.value.trim(),
          }),
          actionButton("保存为引导", () => mutate(item, "steer", editDraft.value.trim()), {
            disabled: !!changing.value || !editDraft.value.trim(),
          }),
        ]),
      ]);
    const queueRow = (item) =>
      editing.value === item.id
        ? editRow(item)
        : [
            h("span", { class: "prompt-queue-text" }, item.text),
            h("div", { class: "prompt-queue-item-actions" }, [
              actionButton(
                item.kind === "followUp" ? "转为引导" : "转为排队",
                () => mutate(item, item.kind === "followUp" ? "steer" : "followUp"),
                { disabled: !!changing.value },
              ),
              actionButton("编辑", () => beginEdit(item), {
                class: "prompt-queue-icon-button",
                disabled: !!changing.value,
                ariaLabel: `编辑排队消息：${item.text}`,
                icon: "edit",
              }),
              actionButton("删除", () => remove(item), {
                class: "prompt-queue-icon-button",
                disabled: !!changing.value,
                ariaLabel: `删除排队消息：${item.text}`,
                icon: "close",
              }),
            ]),
          ];
    const group = (label, description, items) =>
      h("section", { class: "prompt-queue-group" }, [
        h("h3", { class: "prompt-queue-group-head" }, [
          h("strong", label),
          h("span", { class: "prompt-queue-count" }, String(items.length)),
          h("span", { class: "prompt-queue-description muted" }, description),
        ]),
        h(
          "ol",
          items.map((item) =>
            h(
              "li",
              { key: item.id, class: { "is-editing": editing.value === item.id } },
              queueRow(item),
            ),
          ),
        ),
      ]);

    return () =>
      h("div", { class: "prompt-queue-panel" }, [
        h("div", { class: "prompt-queue-head" }, [
          h("strong", `消息队列 · ${session.promptQueue.count}`),
          h("span", { class: "muted" }, "Prompt 默认排队，可在这里转为当前轮引导"),
        ]),
        h(
          "div",
          { class: "prompt-queue-lists" },
          [
            ["引导当前轮", "Steering 会尽快送入正在运行的模型轮次", session.promptQueue.steering],
            ["排队后续轮", "Follow-up 会在当前轮结束后执行", session.promptQueue.followUp],
          ]
            .filter(([, , items]) => items.length > 0)
            .map(([label, description, items]) =>
              group(label, description, items),
            ),
        ),
      ]);
  },
});
