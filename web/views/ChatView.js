import {
  defineComponent,
  defineAsyncComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
} from "vue";
import { useSessionStore } from "../stores/session.js";
import { useComposerStore } from "../stores/composer.js";
import { useSettingsStore } from "../stores/settings.js";
import { postAction } from "../api/actions.js";
import ConversationFeed from "../components/conversation/ConversationFeed.js";
import ComposerDock from "../components/composer/ComposerDock.js";
import ColumnResizer from "../components/layout/ColumnResizer.js";
import ViewTabs from "../components/layout/ViewTabs.js";
import { icon } from "../icons.js";

const ContextView = defineAsyncComponent(() => import("./ContextView.js"));
const SettingsView = defineAsyncComponent(() => import("./SettingsView.js"));

// 对话与轨迹共用同一个消息区（只是渲染方式不同），切换 tab 时保持挂载，避免丢失滚动位置。
const FEED_VIEWS = ["chat", "trace"];

export default defineComponent({
  name: "ChatView",
  props: { token: String, onError: Function, onLoadOlderHistory: Function },
  setup(props) {
    const session = useSessionStore(),
      composer = useComposerStore(),
      settings = useSettingsStore();
    const atBottom = shallowRef(true);
    const conversationFeed = shallowRef();
    const renaming = ref(false);
    const nameDraft = ref("");
    const nameInput = ref();
    composer.initView(settings.defaultView);
    let observer, scrollbarObserver;
    onMounted(() => {
      const dock = document.querySelector(".compose-wrap");
      observer = new ResizeObserver(() => {
        document.documentElement.style.setProperty(
          "--compose-height",
          `${dock.getBoundingClientRect().height}px`,
        );
      });
      observer.observe(dock);
      // 滚动条占位会让 #scroll 的内容盒比 main 窄，而 dock 在 main 里居中；
      // 需要把滚动条宽度写进变量，让 dock 左移半个滚动条，才能和消息列完全对齐。
      const scroll = document.querySelector("#scroll");
      if (scroll) {
        const syncScrollbar = () => {
          document.documentElement.style.setProperty(
            "--scrollbar-width",
            `${scroll.offsetWidth - scroll.clientWidth}px`,
          );
        };
        // 内容盒尺寸变化即滚动条出现或消失，用 content-box 观察才收得到。
        scrollbarObserver = new ResizeObserver(syncScrollbar);
        scrollbarObserver.observe(scroll, { box: "content-box" });
        syncScrollbar();
      }
    });
    onUnmounted(() => {
      observer?.disconnect();
      scrollbarObserver?.disconnect();
      document.documentElement.style.removeProperty("--compose-height");
      document.documentElement.style.removeProperty("--scrollbar-width");
    });
    const bottom = () => {
      conversationFeed.value?.scrollToBottom();
    };
    const activity = () =>
      session.connection !== "connected"
        ? "连接已断开"
        : session.busy
          ? `正在生成${session.pending ? " · 有排队消息" : ""}`
          : session.pending
            ? "消息已排队"
            : "已同步";
    const startRename = () => {
      renaming.value = true;
      nameDraft.value = session.name === "未命名会话" ? "" : session.name;
      nextTick(() => nameInput.value?.focus?.());
    };
    const cancelRename = () => {
      renaming.value = false;
    };
    // 复用 TUI 的 /name 命令：后端会调用 pi.setSessionName() 并回推新名称。
    const submitRename = async () => {
      const name = nameDraft.value.trim();
      renaming.value = false;
      if (!name || name === session.name) return;
      try {
        await postAction(props.token, {
          type: "send",
          text: `/name ${name}`,
          sessionId: session.sessionId,
          mode: "followUp",
        });
      } catch (error) {
        props.onError?.(error.message);
      }
    };
    const head = () =>
      h("div", { class: "toolbar-head" }, [
        renaming.value
          ? h("input", {
              ref: nameInput,
              id: "rename-session-input",
              class: "rename-input",
              value: nameDraft.value,
              "aria-label": "会话名称",
              onInput: (event) => {
                nameDraft.value = event.target.value;
              },
              onKeydown: (event) => {
                if (event.key === "Enter") submitRename();
                else if (event.key === "Escape") cancelRename();
              },
              onBlur: cancelRename,
            })
          : h("strong", { id: "view-title" }, session.name || "未命名会话"),
        !renaming.value &&
          h(
            "button",
            {
              id: "rename-session",
              type: "button",
              class: "icon-button",
              "aria-label": "重命名会话",
              title: "重命名会话",
              onClick: startRename,
            },
            [icon("edit")],
          ),
        h("span", { id: "activity" }, activity()),
      ]);
    return () =>
      h("div", { class: "layout" }, [
        h("main", [
          h("div", { class: "toolbar" }, [
            head(),
            h(ViewTabs, {
              view: composer.view,
              onSelect: (view) => composer.setView(view),
            }),
          ]),
          h("div", { class: "view-panes" }, [
            // 消息区始终保留在布局里（只切 visibility），否则切回来时整段 transcript
            // 要重新布局：300 轮会话实测达 100–130ms 的可见卡顿。
            h(
              "div",
              {
                class: [
                  "view-pane",
                  "feed-pane",
                  !FEED_VIEWS.includes(composer.view) && "is-inactive",
                ],
                id: "view-panel-feed",
              },
              [
                h(ConversationFeed, {
                  ref: conversationFeed,
                  trace: composer.view === "trace",
                  token: props.token,
                  onError: props.onError,
                  onLoadOlderHistory: props.onLoadOlderHistory,
                  onAtBottomChange: (value) => {
                    atBottom.value = value;
                  },
                }),
              ],
            ),
            composer.view === "context" && h(
              "div",
              {
                class: [
                  "view-pane",
                  "page-pane",
                  "is-active",
                ],
                id: "view-panel-context",
              },
              [h(ContextView)],
            ),
            composer.view === "settings" && h(
              "div",
              {
                class: [
                  "view-pane",
                  "page-pane",
                  "is-active",
                ],
                id: "view-panel-settings",
              },
              [h(SettingsView)],
            ),
          ]),
          !atBottom.value && FEED_VIEWS.includes(composer.view)
            ? h(
                "button",
                {
                  id: "jump-to-bottom",
                  type: "button",
                  "aria-label": "跳到最新消息",
                  title: "跳到最新消息",
                  onClick: bottom,
                },
                icon("down"),
              )
            : null,
          // 上下文/设置页不显示输入 dock；保持挂载（否则 ResizeObserver 失去观察目标），
          // 用 CSS 隐藏让 --compose-height 归零，页面内容才能铺到底部。
          h(
            "div",
            {
              class: [
                "dock-host",
                !FEED_VIEWS.includes(composer.view) && "is-hidden",
              ],
            },
            [h(ComposerDock, props)],
          ),
          h(ColumnResizer),
        ]),
      ]);
  },
});
