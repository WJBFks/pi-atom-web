import {
  computed,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { useSessionStore } from "../../stores/session.js";
import { useConversationStore } from "../../stores/conversation.js";
import { useComposerStore } from "../../stores/composer.js";
import { postAction } from "../../api/actions.js";
import { icon } from "../../icons.js";
import { writeClipboard } from "../../clipboard.js";
import RequestDock from "../dialogs/RequestDock.js";
import CommandMenu from "./CommandMenu.js";
import ModelPicker from "./ModelPicker.js";
import ThinkingPicker from "./ThinkingPicker.js";
import SessionStatus from "../status/SessionStatus.js";

const assistantText = (message) =>
  message?.role === "assistant"
    ? typeof message.content === "string"
      ? message.content
      : (message.content || [])
          .filter((block) => block.type === "text")
          .map((block) => block.text || "")
          .join("\n")
          .trim()
    : "";

export default defineComponent({
  name: "ComposerDock",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore(),
      conversation = useConversationStore(),
      composer = useComposerStore(),
      prompt = ref(),
      dock = ref(),
      notice = ref("");
    let noticeTimer,
      observer,
      alive = true;
    const controllers = new Set();
    const matches = computed(() => composer.matches(session));
    const commandVisible = computed(() =>
      Boolean(
        composer.commandQuery &&
          session.connection === "connected" &&
          composer.dismissed !== composer.draft,
      ),
    );
    const modelName = computed(
      () =>
        session.modelOptions.find(
          (item) =>
            item.provider === session.selectedModel?.provider &&
            item.id === session.selectedModel?.id,
        )?.name ||
        String(session.model || "未选择模型")
          .split("/")
          .at(-1)
          .trim(),
    );
    const resize = () =>
      nextTick(() => {
        const node = prompt.value;
        if (!node) return;
        const lineHeight =
          Number.parseFloat(getComputedStyle(node).lineHeight) || 22.4;
        const main = node.closest("main");
        const dockHeight = dock.value?.getBoundingClientRect().height || 0;
        const available = Math.max(
          lineHeight * 2,
          (main?.clientHeight || window.innerHeight) -
            dockHeight +
            node.offsetHeight -
            32,
        );
        const maxHeight = Math.min(lineHeight * 10, available);
        node.style.height = "auto";
        node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
        node.style.overflowY =
          node.scrollHeight > maxHeight ? "auto" : "hidden";
      });
    const focus = () => nextTick(() => prompt.value?.focus());
    const complete = (index) => {
      const match = matches.value[index];
      if (!match) return;
      composer.setDraft(`/${match.name} `);
      resize();
      focus();
    };
    const setPicker = (value) => {
      if (session.busy) return;
      const opening = composer.picker !== value;
      composer.togglePicker(value, session.modelOptions);
      if (value === "model" && opening) {
        const providers = [
          ...new Set(session.modelOptions.map((model) => model.provider)),
        ];
        composer.provider =
          session.selectedModel?.provider ||
          (!session.selectedModel && providers.length === 1
            ? providers[0]
            : null);
      }
    };
    const request = async (action) => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await postAction(
          props.token,
          action,
          undefined,
          controller.signal,
        );
      } finally {
        controllers.delete(controller);
      }
    };
    const report = (error) => {
      if (alive && error?.name !== "AbortError") props.onError?.(error);
    };
    const selectModel = async (model) => {
      if (session.busy) return;
      try {
        await request({
          type: "select_model",
          sessionId: session.sessionId,
          provider: model.provider,
          modelId: model.id,
        });
        if (alive) composer.picker = null;
      } catch (error) {
        report(error);
      }
    };
    const selectThinking = async (level) => {
      if (session.busy) return;
      try {
        await request({
          type: "select_thinking",
          sessionId: session.sessionId,
          level,
        });
        if (alive) composer.picker = null;
      } catch (error) {
        report(error);
      }
    };
    const showNotice = (value) => {
      notice.value = value;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        notice.value = "";
      }, 1800);
    };
    const localCommand = async (text) => {
      const match = /^\/(model|session|copy)(?:\s+(.*))?$/.exec(text);
      if (!match) return false;
      if (match[2]) {
        props.onError?.(new Error(`用法：/${match[1]}`));
        return true;
      }
      composer.clear();
      if (match[1] === "model") setPicker("model");
      if (match[1] === "session") {
        composer.picker = null;
        composer.popover = "status-session";
      }
      if (match[1] === "copy") {
        const value = [
          ...conversation.messages,
          ...(conversation.liveMessage ? [conversation.liveMessage] : []),
        ]
          .reverse()
          .map(assistantText)
          .find(Boolean);
        if (!value) props.onError?.(new Error("当前会话没有可复制的助手文本"));
        else {
          await writeClipboard(value);
          showNotice("已复制最后一条助手文本");
        }
      }
      resize();
      return true;
    };
    const submit = async () => {
      const text = composer.draft;
      if (
        !text.trim() ||
        composer.sending ||
        session.connection !== "connected"
      )
        return;
      const trimmed = text.trim();
      try {
        if (await localCommand(trimmed)) return;
        const reload = trimmed === "/reload";
        if (reload)
          sessionStorage.setItem(
            "atom-refresh-after-reload",
            session.instanceId || "legacy",
          );
        const sessionId = session.sessionId;
        const optimisticId = trimmed.startsWith("/")
          ? null
          : conversation.addOptimisticUserMessage(trimmed);
        composer.sending = true;
        try {
          await request({ type: "send", text, sessionId, mode: "followUp" });
          if (
            alive &&
            session.sessionId === sessionId &&
            composer.draft === text
          )
            composer.clear();
          resize();
        } catch (error) {
          if (optimisticId)
            conversation.removeOptimisticUserMessage(optimisticId);
          if (reload && !(error instanceof TypeError))
            sessionStorage.removeItem("atom-refresh-after-reload");
          report(error);
        } finally {
          if (alive) composer.sending = false;
        }
      } catch (error) {
        report(error);
      }
    };
    const keydown = (event) => {
      if (event.isComposing) return;
      if (commandVisible.value) {
        if (event.key === "Escape") {
          event.preventDefault();
          composer.dismissCommands();
          return;
        }
        if (
          matches.value.length &&
          ["ArrowDown", "ArrowUp"].includes(event.key)
        ) {
          event.preventDefault();
          composer.commandIndex =
            (composer.commandIndex +
              (event.key === "ArrowDown" ? 1 : -1) +
              matches.value.length) %
            matches.value.length;
          nextTick(() =>
            document
              .getElementById(`command-${composer.commandIndex}`)
              ?.scrollIntoView({ block: "nearest" }),
          );
          return;
        }
        if (
          matches.value.length &&
          (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
        ) {
          event.preventDefault();
          complete(composer.commandIndex);
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    };
    const outside = (event) => {
      if (
        !event.target.closest(".setting-picker") &&
        !event.target.closest(".composer-setting")
      )
        composer.picker = null;
    };
    watch(
      () => session.sessionId,
      (next, previous) => {
        if (previous) composer.saveDraft(previous);
        composer.restoreDraft(next);
        composer.closeOverlays();
        resize();
      },
    );
    onMounted(() => {
      resize();
      const main = prompt.value?.closest("main");
      observer = new ResizeObserver(resize);
      if (main) observer.observe(main);
      document.addEventListener("pointerdown", outside);
    });
    onUnmounted(() => {
      alive = false;
      clearTimeout(noticeTimer);
      observer?.disconnect();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      document.removeEventListener("pointerdown", outside);
    });
    return () =>
      h("section", { ref: dock, class: "compose-wrap" }, [
        h(RequestDock, props),
        session.error
          ? h("div", { id: "error", role: "alert" }, session.error)
          : null,
        notice.value
          ? h("div", { id: "notice", role: "status" }, notice.value)
          : null,
        h(
          "form",
          {
            id: "composer",
            onSubmit: (event) => {
              event.preventDefault();
              submit();
            },
          },
          [
            h(CommandMenu, {
              matches: matches.value,
              query: commandVisible.value,
              index: composer.commandIndex,
              commands: session.commands,
              onComplete: complete,
            }),
            h("textarea", {
              id: "prompt",
              ref: prompt,
              value: composer.draft,
              rows: 2,
              placeholder: "消息输入 / 使用命令，输入 @ 查找文件",
              "aria-label": "消息",
              "aria-controls": "command-list",
              "aria-autocomplete": "list",
              "aria-expanded": String(commandVisible.value),
              "aria-activedescendant": matches.value.length
                ? `command-${composer.commandIndex}`
                : undefined,
              onInput: (event) => {
                composer.setDraft(event.target.value);
                resize();
              },
              onKeydown: keydown,
            }),
            h("div", { class: "compose-actions" }, [
              h("div", { class: "compose-left" }),
              h("div", { class: "compose-right" }, [
                h(
                  "button",
                  {
                    id: "model-button",
                    type: "button",
                    class: "composer-setting",
                    "aria-expanded": String(composer.picker === "model"),
                    disabled: session.busy,
                    onClick: () => setPicker("model"),
                  },
                  modelName.value,
                ),
                h(
                  "button",
                  {
                    id: "thinking-button",
                    type: "button",
                    class: "composer-setting",
                    "aria-expanded": String(composer.picker === "thinking"),
                    disabled: session.busy,
                    onClick: () => setPicker("thinking"),
                  },
                  session.thinking || "off",
                ),
                session.busy
                  ? h(
                      "button",
                      {
                        type: "button",
                        id: "stop",
                        "aria-label": "停止生成",
                        onClick: () =>
                          request({
                            type: "abort",
                            sessionId: session.sessionId,
                          }).catch(report),
                      },
                      icon("stop"),
                    )
                  : null,
                h(
                  "button",
                  {
                    type: "submit",
                    class: "primary",
                    id: "send",
                    "aria-label": "发送",
                    disabled:
                      !composer.draft.trim() ||
                      composer.sending ||
                      session.connection !== "connected",
                  },
                  icon("send"),
                ),
              ]),
            ]),
            composer.picker === "model"
              ? h(ModelPicker, {
                  models: session.modelOptions,
                  selected: session.selectedModel,
                  provider: composer.provider,
                  query: composer.modelQuery,
                  busy: session.busy,
                  chooseProvider: (value) => composer.selectProvider(value),
                  updateQuery: (value) => (composer.modelQuery = value),
                  chooseModel: selectModel,
                })
              : null,
            composer.picker === "thinking"
              ? h(ThinkingPicker, {
                  levels: session.thinkingLevels,
                  selected: session.thinking,
                  busy: session.busy,
                  chooseLevel: selectThinking,
                })
              : null,
          ],
        ),
        h(SessionStatus),
      ]);
  },
});
