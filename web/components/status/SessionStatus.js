import { defineComponent, h, ref, onMounted, onUnmounted } from "vue";
import { useSessionStore } from "../../stores/session.js";
import { useComposerStore } from "../../stores/composer.js";
import { icon } from "../../icons.js";
import StatusPopover from "./StatusPopover.js";
import { statusValues } from "./format.js";

export default defineComponent({
  name: "SessionStatus",
  setup() {
    const session = useSessionStore(),
      composer = useComposerStore(),
      now = ref(Date.now());
    let timer;
    onMounted(() => {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    });
    onUnmounted(() => clearInterval(timer));
    const toggle = (kind) => {
      const key = `status-${kind}`;
      composer.popover = composer.popover === key ? null : key;
    };
    const text = (key, values) =>
      h("span", { "data-status-value": key }, values[key]);
    return () => {
      const values = statusValues(session, now.value);
      const button = (kind, children) =>
        h(
          "button",
          {
            key: kind,
            type: "button",
            "data-status": kind,
            "aria-expanded": composer.popover === `status-${kind}`,
            onClick: () => toggle(kind),
          },
          children,
        );
      return h("div", { class: "status-shell" }, [
        composer.popover?.startsWith("status-") &&
          h(StatusPopover, {
            session,
            kind: composer.popover.slice(7),
            now: now.value,
          }),
        h("div", { id: "session-status", class: "status-bar" }, [
          button("session", [icon("session"), text("session", values)]),
          button("conversation", [
            icon("conversation"),
            text("conversation", values),
          ]),
          button("tokens", [
            icon("up"),
            text("input", values),
            icon("down"),
            text("output", values),
            icon("tokens"),
            text("total", values),
          ]),
          button("cache", [icon("cache"), text("cache", values)]),
        ]),
      ]);
    };
  },
});
