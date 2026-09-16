import { defineComponent, h, ref } from "vue";
import { useSessionStore } from "../../stores/session.js";
import { useDialogRequests } from "../../stores/dialog-requests.js";
import CustomTerminal from "./CustomTerminal.js";
import { packageRequestComponent } from "../../packages/registry.js";

// 导出给活动组件栏复用（活动组件 = 扩展请求）
export const GeneralRequest = defineComponent({
  name: "GeneralRequest",
  props: {
    request: Object,
    token: String,
    pending: Boolean,
    respond: Function,
    onError: Function,
  },
  setup(props) {
    const text = ref("");
    return () => {
      const request = props.request;
      const reply = (value, cancel = false) =>
        props.respond(request.id, value, cancel);
      const content = [request.text && h("p", request.text)];
      if (request.kind === "select")
        content.push(
          h(
            "div",
            { class: "request-options" },
            (request.options || []).map((option, index) =>
              h(
                "button",
                {
                  key: index,
                  type: "button",
                  disabled: props.pending,
                  "data-choice": index,
                  onClick: () => reply(index),
                },
                option || " ",
              ),
            ),
          ),
        );
      if (request.kind === "input")
        content.push(
          h("textarea", {
            "aria-label": "扩展请求输入",
            value: text.value,
            disabled: props.pending,
            onInput: (event) => {
              text.value = event.target.value;
            },
          }),
          h(
            "button",
            {
              type: "button",
              disabled: props.pending,
              "data-reply": "input",
              onClick: () => reply(text.value),
            },
            "提交",
          ),
        );
      if (request.kind === "confirm")
        content.push(
          h(
            "button",
            {
              type: "button",
              disabled: props.pending,
              "data-reply": "confirm",
              onClick: () => reply(true),
            },
            "确认",
          ),
        );
      if (request.kind === "custom")
        content.push(
          h(CustomTerminal, {
            request,
            token: props.token,
            onError: props.onError,
          }),
          h(
            "p",
            { class: "terminal-hint" },
            "点击终端后直接输入 · 支持方向键、Tab、退格及 Ctrl 组合键",
          ),
        );
      if (request.terminalOnly)
        content.push(h("p", "此请求需要在 TUI 编辑器中完成。"));

      // 三段式：顶部标题行与底部操作栏固定，只有正文滚动。
      // （原先整块塞进 details，标题与按钮都会跟着内容滚走。）
      return h(
        "div",
        { class: "plugin-request", "data-request": request.id },
        [
          h("div", { class: "plugin-request-head" }, [
            h("div", { class: "role" }, `扩展请求 · ${request.kind}`),
            h("strong", request.title),
          ]),
          h("div", { class: "plugin-request-body" }, content),
          h("div", { class: "plugin-request-foot" }, [
            request.terminalOnly
              ? null
              : h(
                  "button",
                  {
                    type: "button",
                    disabled: props.pending,
                    "data-reply": "cancel",
                    onClick: () => reply(undefined, true),
                  },
                  "取消 / 关闭",
                ),
            h("small", "如果显示出现异常，可以在 TUI 中操作"),
          ]),
        ],
      );
    };
  },
});

/**
 * 单个扩展请求的渲染：有 `packageId` 且注册了专用组件时用专用组件，
 * 否则回退到通用 `GeneralRequest`。活动组件栏与请求面板共用它，
 * 避免两处各写一份「选组件」的分支。
 */
export const RequestView = defineComponent({
  name: "RequestView",
  props: {
    request: Object,
    token: String,
    pending: Boolean,
    respond: Function,
    onError: Function,
  },
  setup(props) {
    return () => {
      const request = props.request;
      const PackageRequest = request.packageId
        ? packageRequestComponent(request.packageId)
        : null;
      return PackageRequest
        ? h(PackageRequest, {
            request,
            pending: props.pending,
            onSubmit: (detail) =>
              props.respond(
                detail.id,
                {
                  draft: detail.draft,
                  ...(detail.globalNote ? { globalNote: detail.globalNote } : {}),
                },
                detail.cancel,
              ),
          })
        : h(GeneralRequest, {
            request,
            token: props.token,
            pending: props.pending,
            respond: props.respond,
            onError: props.onError,
          });
    };
  },
});

export default defineComponent({
  name: "RequestDock",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore();
    // 应答逻辑与活动组件栏共用同一份实现（stores/dialog-requests.js）
    const { requests, pending, respond } = useDialogRequests(
      props.token,
      (error) => props.onError?.(error),
    );
    return () =>
      h(
        "section",
        { id: "plugin-requests", "aria-label": "扩展请求" },
        requests().map((request) =>
            h(RequestView, {
              key: `${session.sessionId}:${request.id}`,
              request,
              token: props.token,
              pending: pending.has(request.id),
              respond,
              onError: props.onError,
            }),
          ),
      );
  },
});
