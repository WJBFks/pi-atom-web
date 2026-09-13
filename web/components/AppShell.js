import { defineComponent, h, onMounted, onUnmounted, watch } from "vue";
import { RouterView } from "vue-router";
import { useSessionStore } from "../stores/session.js";
import { useConversationStore } from "../stores/conversation.js";
import { useDialogsStore } from "../stores/dialogs.js";
import { useComposerStore } from "../stores/composer.js";
import { consumeToken, createEventStream } from "../api/event-stream.js";
import { postAction } from "../api/actions.js";

export default defineComponent({
  name: "AppShell",
  setup() {
    const session = useSessionStore(),
      conversation = useConversationStore();
    const dialogs = useDialogsStore(),
      composer = useComposerStore();
    const token = consumeToken(location);
    document.documentElement.classList.toggle(
      "dark",
      localStorage.getItem("atom-theme") === "dark",
    );
    let stream;
    let persistTimer;
    conversation.configurePersistence((state) => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        if (!session.sessionId || !token) return;
        postAction(token, {
          type: "save_ui_state",
          sessionId: session.sessionId,
          ...state,
        }).catch((error) => { session.error = error.message; });
      }, 100);
    });
    const apply = (event) => {
      const data = event.type === "snapshot" ? event.snapshot : event.patch;
      if (event.type === "snapshot") {
        session.applySnapshot(data);
        conversation.applySnapshot(data);
        dialogs.applySnapshot(data);
      } else {
        session.applyPatch(data);
        conversation.applyPatch(data);
        dialogs.applyPatch(data);
      }
      const old = sessionStorage.getItem("atom-refresh-after-reload");
      if (old && session.instanceId && old !== session.instanceId) {
        sessionStorage.removeItem("atom-refresh-after-reload");
        location.reload();
      }
    };
    const dismiss = (event) => {
      const target = event.target;
      if (
        composer.popover?.startsWith("status-") &&
        !target.closest(
          `#status-popover, [data-status="${composer.popover.slice(7)}"]`,
        )
      )
        composer.popover = null;
    };
    const stop = () => {
      stream?.stop();
      stream = undefined;
      clearTimeout(persistTimer);
    };
    onMounted(() => {
      document.addEventListener("pointerdown", dismiss);
      window.addEventListener("pagehide", stop);
      if (!token) {
        session.connection = "failed";
        session.error = "请在 pi TUI 中执行 /web，使用完整地址打开页面。";
        return;
      }
      stream = createEventStream({
        token,
        onSnapshotHeader: (event) => {
          const old = sessionStorage.getItem("atom-refresh-after-reload");
          const next = event?.snapshot?.instanceId;
          if (!old || typeof next !== "string" || !next || next.length > 512 || old === next)
            return false;
          sessionStorage.removeItem("atom-refresh-after-reload");
          location.reload();
          return true;
        },
        onEvent: apply,
        onState: (value) => {
          session.connection = value;
          if (value === "connected") session.error = "";
        },
        onError: (error) => {
          session.error = error.message;
        },
      });
    });
    onUnmounted(() => {
      stop();
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("pagehide", stop);
    });
    watch(
      () => session.name,
      (name) => {
        document.title = `${name || "未命名会话"} · pi-atom-web`;
      },
    );
    return () =>
      h("div", { id: "app-shell" }, [
        h(RouterView, null, {
          default: ({ Component }) =>
            Component &&
            h(Component, {
              token,
              onError: (error) => {
                session.error = error.message;
              },
            }),
        }),
      ]);
  },
});
