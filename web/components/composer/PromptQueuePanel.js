import { defineComponent, h, shallowRef } from "vue";
import { postAction } from "../../api/actions.js";
import { icon } from "../../icons.js";
import { useSessionStore } from "../../stores/session.js";
import { PreviewImage } from "../conversation/MessageItem.js";
import { imagePayload, imageUrl, readImageFiles } from "./image-files.js";

export default defineComponent({
  name: "PromptQueuePanel",
  props: { token: String, flash: Object, onError: Function },
  setup(props) {
    const session = useSessionStore();
    const changing = shallowRef(null);
    const editing = shallowRef(null);
    const editDraft = shallowRef("");
    const editImages = shallowRef([]);
    const imageInput = shallowRef();
    const request = (action) =>
      postAction(props.token, { ...action, sessionId: session.sessionId });

    const mutate = async (item, kind, text = item.text, images = item.images || []) => {
      if (changing.value) return false;
      changing.value = item.id;
      try {
        await request({
          type: "queue_update_item",
          id: item.id,
          revision: session.promptQueue.revision,
          kind,
          text,
          images: imagePayload(images),
        });
        editing.value = null;
        editDraft.value = "";
        editImages.value = [];
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
      editImages.value = (item.images || []).map((image, index) => ({
        ...image,
        name: `队列图片 ${index + 1}`,
        url: imageUrl(image),
      }));
    };
    const cancelEdit = () => {
      editing.value = null;
      editDraft.value = "";
      editImages.value = [];
    };
    const addEditImages = async (files) => {
      try {
        const added = await readImageFiles(files);
        if (added.length) editImages.value = [...editImages.value, ...added];
      } catch (error) {
        props.onError?.(error);
      }
    };
    const pastedImages = (event) => {
      const files = [...(event.clipboardData?.items || [])]
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      addEditImages(files);
    };
    const imageStrip = (images, removable = false) =>
      images.length
        ? h("div", { class: "image-attachments prompt-queue-images", "aria-label": "排队消息图片" },
            images.map((image, index) => h("div", {
              class: "image-attachment",
              key: `${image.mimeType}:${index}:${image.data?.slice(0, 12)}`,
            }, [
              h(PreviewImage, {
                src: imageUrl(image),
                alt: image.name || `队列图片 ${index + 1}`,
                imageClass: "attachment-image",
              }),
              removable ? h("button", {
                type: "button",
                class: "image-remove",
                "aria-label": `移除队列图片 ${index + 1}`,
                onClick: () => {
                  editImages.value = editImages.value.filter((_, position) => position !== index);
                },
              }, icon("close")) : null,
            ])),
          )
        : null;
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
      h("div", {
        class: "prompt-queue-editor",
        onDragover: (event) => {
          if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file" && entry.type.startsWith("image/")))
            event.preventDefault();
        },
        onDrop: (event) => {
          const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
          if (!files.length) return;
          event.preventDefault();
          addEditImages(files);
        },
      }, [
        h("textarea", {
          rows: 2,
          value: editDraft.value,
          "aria-label": "编辑排队消息",
          onInput: (event) => (editDraft.value = event.target.value),
          onPaste: pastedImages,
          onKeydown: (event) => {
            if (event.key === "Escape") cancelEdit();
          },
        }),
        imageStrip(editImages.value, true),
        h("div", { class: "prompt-queue-editor-actions" }, [
          h("input", {
            ref: imageInput,
            class: "image-input",
            type: "file",
            accept: "image/*",
            multiple: true,
            onChange: (event) => {
              addEditImages(event.target.files || []);
              event.target.value = "";
            },
          }),
          actionButton("添加图片", () => imageInput.value?.click(), {
            class: "prompt-queue-icon-button",
            disabled: !!changing.value,
            icon: "image",
          }),
          actionButton("取消", cancelEdit, { disabled: !!changing.value }),
          actionButton("保存为排队", () => mutate(item, "followUp", editDraft.value.trim(), editImages.value), {
            disabled: !!changing.value || (!editDraft.value.trim() && !editImages.value.length),
          }),
          actionButton("保存为引导", () => mutate(item, "steer", editDraft.value.trim(), editImages.value), {
            disabled: !!changing.value || (!editDraft.value.trim() && !editImages.value.length),
          }),
        ]),
      ]);
    const queueRow = (item) =>
      editing.value === item.id
        ? editRow(item)
        : [
            h("div", { class: "prompt-queue-content" }, [
              imageStrip(item.images || []),
              item.text ? h("span", { class: "prompt-queue-text" }, item.text) : null,
            ]),
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
    const group = (kind, label, description, items) =>
      h("section", {
        class: [
          "prompt-queue-group",
          `prompt-queue-${kind}`,
        ],
        "data-queue-kind": kind,
      }, [
        h("h3", { class: "prompt-queue-group-head" }, [
          h("strong", label),
          h("span", { class: "prompt-queue-count" }, String(items.length)),
          h("span", { class: "prompt-queue-description muted" }, description),
        ]),
        h(
          "ol",
          items.length
            ? items.map((item, index) => {
                const flashing = props.flash?.items?.includes(`${kind}:${index}`);
                return h(
                  "li",
                  {
                    key: `${item.id}:${flashing ? props.flash.nonce : 0}`,
                    class: [
                      "prompt-queue-item",
                      {
                        "is-editing": editing.value === item.id,
                        "is-flashing": flashing,
                      },
                    ],
                  },
                  queueRow(item),
                );
              })
            : [h("li", { class: "prompt-queue-empty muted" }, "暂无")],
        ),
      ]);

    return () =>
      h("div", { class: "prompt-queue-panel" }, [
        h(
          "div",
          { class: "prompt-queue-lists" },
          [
            ["steering", "引导队列", "Steering 会尽快送入正在运行的模型轮次", session.promptQueue.steering],
            ["followUp", "排队队列", "Follow-up 会在当前轮结束后执行", session.promptQueue.followUp],
          ]
            .map(([kind, label, description, items]) =>
              group(kind, label, description, items),
            ),
        ),
      ]);
  },
});
