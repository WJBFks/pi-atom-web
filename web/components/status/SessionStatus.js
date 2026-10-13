import { defineComponent, h, ref, onMounted, onUnmounted, onUpdated } from "vue";
import { useSessionStore } from "../../stores/session.js";
import { useComposerStore } from "../../stores/composer.js";
import { icon } from "../../icons.js";
import StatusPopover from "./StatusPopover.js";
import { statusValues } from "./format.js";

/** 压缩级数（与 style.css 里 `.status-bar.compact-N` 的条数一致，改它要两边同步）。 */
const LEVELS = 6;

export default defineComponent({
  name: "SessionStatus",
  setup() {
    const session = useSessionStore(),
      composer = useComposerStore(),
      now = ref(Date.now()),
      bar = ref();
    let timer, observer;
    /*
     * 宽度不够时逐级收紧（用户 2026-09-25 定了顺序）：
     *   1 会话名固定成「会话」 → 2 隐总计 Token → 3 隐轨迹事件数（步）
     *   → 4 隐输入/输出 Token、但把「总计」放回来（那时整个用量按钮只剩这一个数字）
     *   → 5 隐对话轮数（轮） → 6 隐成本（$x.xx）。
     * 累加地打 compact-1..compact-6 类，所以 CSS 只写「第 N 级新增隐什么」（第 4 级是个例外：
     * 它反而要把第 2 级隐掉的总计重新显示出来）。
     * 级别不能按视口断点算：会不会挤成一团取决于会话名与数字到底多宽，所以直接量容器
     * 与内容的宽（scrollWidth / clientWidth），从宽到窄一级一级试到不溢出为止。
     */
    const applyLevel = (node, level) => {
      for (let i = 1; i <= LEVELS; i += 1)
        node.classList.toggle(`compact-${i}`, i <= level);
    };
    const fit = () => {
      const node = bar.value;
      if (!node) return;
      applyLevel(node, 0);
      let level = 0;
      while (level < LEVELS && node.scrollWidth > node.clientWidth + 0.5) {
        level += 1;
        applyLevel(node, level);
      }
    };
    onMounted(() => {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
      observer = new ResizeObserver(fit);
      if (bar.value) observer.observe(bar.value);
      fit();
    });
    // 数值每秒都在变（轮数/Token 位数也会变宽），渲染完再量一次；classList 是直接写在 DOM 上的，
    // Vue 不会动它（vnode 里没有这个类），所以不会每秒重建按钮。
    onUpdated(fit);
    onUnmounted(() => {
      clearInterval(timer);
      observer?.disconnect();
    });
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
        h(
          "div",
          {
            id: "session-status",
            class: "status-bar",
            ref: bar,
          },
          [
            button("session", [
              icon("session"),
              h(
                "span",
                { class: "status-session-name", "data-status-value": "session" },
                values.session,
              ),
              // 固定文案与真名一起挂在 DOM 里，靠级别切显示，不在渲染里改文案（也不重建按钮）。
              h("span", { class: "status-session-fixed" }, "会话"),
            ]),
            button("conversation", [
              icon("conversation"),
              h("span", { class: "status-counts" }, [
                h(
                  "span",
                  { class: "status-turns", "data-status-value": "turns" },
                  values.turns,
                ),
                h(
                  "span",
                  { class: "status-steps", "data-status-value": "steps" },
                  values.steps,
                ),
              ]),
              h(
                "span",
                { class: "status-speed", "data-status-value": "speedText" },
                values.speedText,
              ),
            ]),
            button("tokens", [
              h("span", { class: "status-io" }, [
                icon("up"),
                text("input", values),
                icon("down"),
                text("output", values),
              ]),
              h("span", { class: "status-total" }, [
                icon("tokens"),
                text("total", values),
              ]),
            ]),
            button("cache", [
              icon("cache"),
              text("hit", values),
              h(
                "span",
                {
                  class: "status-cost",
                  "data-status-value": "cost",
                },
                values.cost,
              ),
            ]),
          ],
        ),
      ]);
    };
  },
});
