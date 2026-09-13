import { defineComponent, h, onUnmounted, reactive, ref, watch } from "vue";
import { useDialogsStore } from "../../stores/dialogs.js";
import { useSessionStore } from "../../stores/session.js";
import { postAction } from "../../api/actions.js";
import CustomTerminal from "./CustomTerminal.js";
import AskUserForm from "./AskUserForm.js";

const GeneralRequest = defineComponent({
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
      else
        content.push(
          h(
            "button",
            {
              type: "button",
              disabled: props.pending,
              "data-reply": "cancel",
              onClick: () => reply(undefined, true),
            },
            "取消 / 关闭",
          ),
        );
      content.push(h("small", "也可在 TUI 中操作"));
      return h("div", { class: "plugin-request", "data-request": request.id }, [
        h("div", { class: "role" }, `扩展请求 · ${request.kind}`),
        h("strong", request.title),
        h("details", { open: true }, [h("summary", "展开 / 收起"), ...content]),
      ]);
    };
  },
});

export default defineComponent({
  name: "RequestDock",
  props: { token: String, onError: Function },
  setup(props) {
    const dialogs = useDialogsStore(),
      session = useSessionStore(),
      pending = reactive(new Set()),
      completed = reactive(new Set());
    const controllers = new Map();
    let disposed = false;
    const respond = async (id, value, cancel = false) => {
      if (pending.has(id) || completed.has(id)) return;
      const sessionId = session.sessionId;
      if (session.connection !== "connected") {
        props.onError?.(new Error("连接已断开，请重连后提交"));
        return;
      }
      const controller = new AbortController();
      controllers.set(id, controller);
      pending.add(id);
      try {
        await postAction(
          props.token,
          {
            type: "dialog_response",
            id,
            sessionId,
            ...(value === undefined ? {} : { value }),
            cancel,
          },
          fetch,
          controller.signal,
        );
        if (
          disposed ||
          session.sessionId !== sessionId ||
          controller.signal.aborted
        )
          return;
        completed.add(id);
        try {
          sessionStorage.removeItem(`ask-user:${id}`);
        } catch {}
      } catch (error) {
        if (
          !disposed &&
          session.sessionId === sessionId &&
          !controller.signal.aborted
        )
          props.onError?.(error);
      } finally {
        controllers.delete(id);
        if (!disposed) pending.delete(id);
      }
    };
    watch(
      () => [session.sessionId, dialogs.requests],
      () => {
        if (!session.sessionId) return;
        const ids = new Set(dialogs.requests.map((request) => request.id));
        for (const [id, controller] of controllers)
          if (!ids.has(id)) {
            controller.abort();
            controllers.delete(id);
            pending.delete(id);
          }
        for (const id of completed) if (!ids.has(id)) completed.delete(id);
        const askIds = new Set(
          dialogs.requests
            .filter((request) => request.kind === "ask_user_question")
            .map((request) => request.id),
        );
        try {
          for (const key of Object.keys(sessionStorage))
            if (key.startsWith("ask-user:") && !askIds.has(key.slice(9)))
              sessionStorage.removeItem(key);
        } catch {}
      },
      { immediate: true },
    );
    onUnmounted(() => {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    });
    return () =>
      h(
        "section",
        { id: "plugin-requests", "aria-label": "扩展请求" },
        dialogs.requests
          .filter((request) => !completed.has(request.id))
          .map((request) =>
            request.kind === "ask_user_question"
              ? h(AskUserForm, {
                  key: `${session.sessionId}:${request.id}`,
                  request,
                  pending: pending.has(request.id),
                  onSubmit: (detail) =>
                    respond(detail.id, { draft: detail.draft }, detail.cancel),
                })
              : h(GeneralRequest, {
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
