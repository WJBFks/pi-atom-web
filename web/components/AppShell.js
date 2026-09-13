import { defineComponent, h, onMounted, onUnmounted, watch } from "vue";
import { RouterView } from "vue-router";
import { useSessionStore } from "../stores/session.js";
import { useSettingsStore } from "../stores/settings.js";
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
    // 主题（含跟随系统）、内容列宽度等偏好由 settings store 统一读取并应用。
    useSettingsStore().load();
    let stream;
    let persistTimer;
    // 首屏只带最近若干轮：渲染完后在后台逐页向前补齐（新→旧逆序），
    // 每次都用客户端当前最老一条的 id 当游标，服务端据此再向前切一页。
    let loadingCursor;
    let olderTimer;
    const loadOlderHistory = () => {
      if (!token || !session.sessionId) return;
      if (conversation.historyComplete) return;
      const cursor = conversation.oldestMessageId();
      if (!cursor || cursor === loadingCursor) return;
      loadingCursor = cursor;
      clearTimeout(olderTimer);
      olderTimer = setTimeout(async () => {
        try {
          await postAction(token, {
            type: "more_history",
            sessionId: session.sessionId,
            cursor,
          });
        } catch (error) {
          session.error = error.message;
        } finally {
          loadingCursor = undefined;
        }
      }, 120);
    };
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
      loadOlderHistory();
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
      clearTimeout(olderTimer);
    };
    onMounted(() => {
      document.addEventListener("pointerdown", dismiss);
      window.addEventListener("pagehide", stop);
      if (!token) {
        session.connection = "failed";
        session.error =
          "地址缺少连接凭证：请从 pi TUI 里执行 /web 或 /web-wlan，并复制含 # 之后凭证的完整地址打开。";
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
