import { defineComponent, h, onMounted, onUnmounted } from "vue";
import { useSessionStore } from "../stores/session.js";
import { useComposerStore } from "../stores/composer.js";
import ConversationFeed from "../components/conversation/ConversationFeed.js";
import ComposerDock from "../components/composer/ComposerDock.js";
import ColumnResizer from "../components/layout/ColumnResizer.js";
import { icon } from "../icons.js";

export default defineComponent({
  name: "ChatView",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore(),
      composer = useComposerStore();
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
      const scroll = document.querySelector("#scroll");
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    };
    const activity = () =>
      session.connection !== "connected"
        ? "连接已断开"
        : session.busy
          ? `正在生成${session.pending ? " · 有排队消息" : ""}`
          : session.pending
            ? "消息已排队"
            : "已同步";
    return () =>
      h("div", { class: "layout" }, [
        h("main", [
          h("div", { class: "toolbar" }, [
            h("div", [
              h(
                "strong",
                { id: "view-title" },
                composer.view === "trace" ? "执行轨迹" : "对话",
              ),
              h("span", { id: "activity" }, activity()),
            ]),
            h("button", { id: "bottom", onClick: bottom }, [
              icon("down"),
              "最新消息",
            ]),
          ]),
          h(ConversationFeed, { trace: composer.view === "trace" }),
          h(ComposerDock, props),
          h(ColumnResizer),
        ]),
      ]);
  },
});
