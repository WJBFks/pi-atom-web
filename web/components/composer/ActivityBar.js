import { defineComponent, h, nextTick, ref, watch } from "vue";
import { icon } from "../../icons.js";
import { useSessionStore } from "../../stores/session.js";
import { useDialogsStore } from "../../stores/dialogs.js";
import { useDialogRequests } from "../../stores/dialog-requests.js";
import { RequestView } from "../dialogs/RequestDock.js";
import PromptQueuePanel from "./PromptQueuePanel.js";

/**
 * 活动组件的 tab 模型。
 *
 * 每个活动组件给出一个 tab（有图标有名字），字段：
 * - `id`：稳定标识（用于展开状态与 React 式 diff）
 * - `priority`：浮点数，可正可负；**大的排在左边**
 * - `arrivedAt`：到达时间戳；优先级相同时**先来的排左边**
 * - `tone`：配色组（`{ color, background, border }`）
 * - `render`：大框内容（返回 VNode）
 *
 * 当前活动组件包括扩展请求，以及生成中或非空时出现的 Prompt 队列。
 */
export const EXTENSION_REQUEST_PRIORITY = 1000;
export const PROMPT_QUEUE_PRIORITY = 500;
export const PROMPT_QUEUE_TONE = {
  color: "#3f759e",
  background: "#edf5fb",
  border: "#c8ddeb",
};
export const EXTENSION_REQUEST_TONE = {
  color: "#8458bc",
  background: "#f4effb",
  border: "#ddcbf0",
};

/**
 * 按 package 定制的 tab 外观（标题/图标/配色）。
 * 未列出的 package（以及不带 packageId 的通用请求）沿用上面的默认紫。
 * 同一档明度、对比度 ≈ 4.5:1。
 */
export const PACKAGE_ACTIVITY_LOOK = {
  "@juicesharp/rpiv-ask-user-question": {
    label: "提问",
    icon: "help",
    tone: { color: "#8a6d1f", background: "#fdf6e3", border: "#f0e0b0" },
  },
};

/** 取某个扩展请求对应的 tab 外观（package 定制优先，否则默认紫）。 */
export function activityLook(request) {
  return PACKAGE_ACTIVITY_LOOK[request?.packageId] || {
    label: request?.title || `扩展请求 · ${request?.kind ?? ""}`.trim(),
    icon: "box",
    tone: EXTENSION_REQUEST_TONE,
  };
}

/**
 * 按优先级降序排列（大的在左）；优先级相等时按到达时间升序（先来的在左）。
 * 纯函数，不修改传入数组；缺字段的按 priority=0 / arrivedAt=0 处理，保证可预测。
 */
export function sortActivityTabs(tabs) {
  const priorityOf = (tab) => (Number.isFinite(tab?.priority) ? tab.priority : 0);
  const arrivedOf = (tab) => (Number.isFinite(tab?.arrivedAt) ? tab.arrivedAt : 0);
  return [...tabs].sort((a, b) => {
    const delta = priorityOf(b) - priorityOf(a);
    return delta !== 0 ? delta : arrivedOf(a) - arrivedOf(b);
  });
}

/**
 * tablist 的键盘移动：左右循环、Home/End。
 * disabled 与已关闭的 tab 都不参与循环；返回 null 表示不移动。
 */
export function nextActivityTab(tabs, current, key) {
  const enabled = tabs.filter((tab) => !tab.disabled);
  if (!enabled.length) return null;
  const index = enabled.findIndex((tab) => tab.id === current);
  const move = (target) => {
    const next = (target + enabled.length) % enabled.length;
    return next === index ? null : enabled[next].id;
  };
  if (index < 0) return enabled[0].id;
  if (key === "ArrowRight") return move(index + 1);
  if (key === "ArrowLeft") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(enabled.length - 1);
  return null;
}

/**
 * 内联 tone：以 CSS 自定义属性下发原始色值（**激活态**的配色）。
 * 未激活态由 CSS 处理，不在这里写死第二套色值，因此深色主题也能自动适配。
 */
function toneStyle(tone) {
  if (!tone) return undefined;
  return {
    ...(tone.color ? { "--tone-color": tone.color } : {}),
    ...(tone.background ? { "--tone-bg": tone.background } : {}),
    ...(tone.border ? { "--tone-border": tone.border } : {}),
  };
}

export default defineComponent({
  name: "ActivityBar",
  props: { token: String, onError: Function },
  setup(props) {
    const session = useSessionStore();
    const dialogs = useDialogsStore();
    // 把「请求 → tab 外观」交给 store，让阻塞提示文案与 tab 上的名字一致
    dialogs.setActivityLook(activityLook);
    // 应答逻辑与请求面板共用同一份实现
    const { requests, pending, respond } = useDialogRequests(
      props.token,
      (error) => props.onError?.(error),
    );
    // 展开的 tab（null = 只有 tab 栏，不展开大框）
    const expanded = ref(null);
    // 键盘导航的焦点位置（与 expanded 分开：左右键只移动焦点，不改展开状态）
    const focused = ref(null);
    const host = ref();
    // 每次从折叠态展开时自增：让大框的 key 变化以重播进出场动画
    // （节点被复用时 CSS animation 不会重跑）。表单状态由 panelBody 自己的
    // key 保留，不随这个 tick 重建。
    const openTick = ref(0);

    /**
     * 每个未完成的扩展请求各占一个 tab；Prompt 队列在生成中或非空时
     * 占一个 tab。队列不会自动展开，避免普通生成过程打断用户输入。
     */
    const tabs = () => {
      const requestTabs = requests().map((request, index) => {
        const look = activityLook(request);
        return {
          id: request.id,
          label: look.label,
          icon: look.icon,
          priority: EXTENSION_REQUEST_PRIORITY,
          arrivedAt: index,
          tone: look.tone,
          request,
        };
      });
      if (session.promptQueue.count > 0)
        requestTabs.push({
          id: "prompt-queue",
          label: `队列 ${session.promptQueue.count}`,
          icon: "mode",
          priority: PROMPT_QUEUE_PRIORITY,
          arrivedAt: Number.MAX_SAFE_INTEGER,
          tone: PROMPT_QUEUE_TONE,
          queue: true,
          autoOpen: false,
        });
      return requestTabs;
    };

    // 可见 tab：按优先级降序（大的在左），优先级相等时先到的在左
    const visible = () => sortActivityTabs(tabs());

    // 正在播退场动画的 tab id（非 null 时大框仍挂载、只是加了 .is-closing）
    const closing = ref(null);

    const collapse = () => {
      // 用户手动折叠过 —— 之后新请求到达不再自动展开（尊重用户选择）
      userCollapsed = true;
      const id = expanded.value;
      if (!id) return;
      // 两阶段折叠：expanded 立刻置 null（tab 行落回输入卡上方），
      // 但把 id 记在 closing 上，让那个大框以 .is-closing 留在树上把退场动画播完。
      // 直接一步置 null 会让 <section> 立刻卸载，根本没有动画可播。
      expanded.value = null;
      closing.value = id;
      window.setTimeout(() => {
        // 期间又被展开/切换了就别收（避免动画结束时误收新打开的那个）
        if (closing.value === id) closing.value = null;
      }, 160);
    };

    // 用户是否手动折叠过（手动折叠后不再自动展开，直到再有新请求时重置判断）
    let userCollapsed = false;
    // 上一次已自动展开过的请求 id 集合，避免重复自动展开同一个
    const autoExpanded = new Set();

    /**
     * 扩展请求到达时自动展开第一个（按活动组件排序后的首个未展开过的请求）。
     * 用户手动折叠过则不再自动展开；已在展开状态时不打断。
     */
    watch(
      () => tabs().map((tab) => tab.id).join("|"),
      () => {
        const list = visible();
        if (!list.length) {
          expanded.value = null;
          autoExpanded.clear();
          userCollapsed = false;
          return;
        }
        if (expanded.value !== null || userCollapsed) return;
        const fresh = list.find(
          (tab) => tab.autoOpen !== false && !autoExpanded.has(tab.id),
        );
        if (!fresh) return;
        autoExpanded.add(fresh.id);
        openTick.value += 1;
        closing.value = null;
        expanded.value = fresh.id;
      },
    );

    /** 把焦点交给指定 tab（切换后原节点会被重建，必须重新聚焦）。 */
    const focusTab = (id) => {
      if (!id) return;
      const node = host.value?.querySelector(`[data-activity-tab="${id}"]`);
      node?.focus?.();
    };

    /**
     * 点 tab：只切换「当前大框展示哪个活动组件」，**不会折叠**。
     * 折叠只能通过最小化按钮（或键盘 Esc）。
     */
    const select = (id) => {
      focused.value = id;
      const wasCollapsed = expanded.value === null;
      if (wasCollapsed) openTick.value += 1;
      closing.value = null; // 取消可能还在播的退场动画
      expanded.value = id;
      // 从收起态进入展开态时会重建 tab 节点（tab 行换到面板内），
      // 原节点被移除后焦点会掉到 body，所以补一次聚焦。
      if (wasCollapsed) queueMicrotask(() => focusTab(id));
    };

    const onKeydown = (event) => {
      if (event.key === "Escape" && expanded.value) {
        event.preventDefault();
        collapse();
        return;
      }
      const list = visible();
      if (!list.length) return;
      const current =
        focused.value ?? expanded.value ?? list[0]?.id ?? null;
      const next = nextActivityTab(list, current, event.key);
      if (!next) return;
      event.preventDefault();
      focused.value = next;
      // 左右键只移动焦点；已有展开的大框则跟随切换（与鼠标点击一致）
      if (expanded.value) expanded.value = next;
      // 必须等重渲染后再聚焦：此刻 DOM 可能仍是被替换掉的旧节点
      nextTick(() => focusTab(next));
    };

    /** tab 的渲染：收起态在输入卡上方，展开态整体升到大框顶部，两者共用。 */
    const tabNode = (tab) =>
      h(
        "div",
        {
          class: ["activity-tab", { "is-active": expanded.value === tab.id }],
          key: tab.id,
          // 配色内联在 tab 上（tone 原色用于激活态，未激活由 CSS 压淡）
          style: toneStyle(tab.tone),
          "data-tone": tab.id,
        },
        [
          h(
            "button",
            {
              type: "button",
              role: "tab",
              id: `activity-tab-${tab.id}`,
              "data-activity-tab": tab.id,
              "aria-selected": expanded.value === tab.id,
              "aria-controls": `activity-panel-${tab.id}`,
              tabindex: (expanded.value ?? focused.value) === tab.id ? 0 : -1,
              title: tab.label,
              onClick: () => select(tab.id),
              onFocus: () => {
                focused.value = tab.id;
              },
            },
            [
              h("span", { class: "activity-tab-icon" }, icon(tab.icon)),
              h("span", { class: "activity-tab-label" }, tab.label),
            ],
          ),
        ],
      );

    return () => {
      const list = visible();
      const current = list.find((tab) => tab.id === expanded.value);
      // 还没有任何活动组件：整条栏不渲染
      if (!list.length) return h("div", { class: "activity-bar", ref: host });

      // 展开后所有 tab 一起升到大框顶部那行；折叠时 tab 行落回输入卡上方。
      //
      // 关键：折叠**不卸载大框**，只把它隐藏（.is-collapsed）。
      // 卸载会销毁内部表单的本地状态（问卷草稿、终端实例等），
      // 用户填到一半的内容会在再次展开时丢失。
      /** 某个活动组件的内容体（请求本体）。 */
      const panelBody = (tab) =>
        h(
          "div",
          {
            class: "activity-panel-body",
            id: `activity-panel-content-${tab.id}`,
          },
          [
            tab.queue
              ? h(PromptQueuePanel, {
                  key: `${session.sessionId}:prompt-queue`,
                  token: props.token,
                  onError: props.onError,
                })
              : h(RequestView, {
                  key: `${session.sessionId}:${tab.id}`,
                  request: tab.request,
                  token: props.token,
                  pending: pending.has(tab.id),
                  respond,
                  onError: props.onError,
                }),
          ],
        );

      const tabsRow = (inPanel) =>
        h(
          "div",
          {
            class: inPanel
              ? "activity-tabs activity-tabs-in-panel"
              : "activity-tabs",
            role: "tablist",
            "aria-label": "活动组件",
            onKeydown,
          },
          inPanel
            ? [
                ...list.map((tab) => tabNode(tab)),
                h(
                  "button",
                  {
                    type: "button",
                    class: "activity-panel-collapse",
                    "data-activity-collapse": "",
                    "aria-label": "最小化",
                    title: "最小化",
                    onClick: collapse,
                  },
                  icon("minus"),
                ),
              ]
            : list.map((tab) => tabNode(tab)),
        );

      // 结构：**一条共享的 tab 行** + 每个请求各自一份"内容体"。
      // 内容体全部保持挂载（只是非当前的隐藏），所以切换/折叠都不会销毁
      // 表单的本地状态（问卷草稿、终端实例等）。
      // 退场动画期间 current 已经不存在（expanded 已置 null），
      // 但那个大框仍要留在树上把退场动画播完，所以这里回退到 closing 的那个。
      const shown = current || list.find((tab) => tab.id === closing.value);
      const isClosing = !current && !!shown;

      return h("div", { class: "activity-bar", ref: host }, [
        // 大框（当前展开的那个）+ 它顶部的那条 tab 行。
        //
        // key 里带上 openTick：折叠→再展开时 key 变化，节点被重建，
        // CSS 进出场动画才会重新播放（否则节点被复用，动画只在首次出现时跑一次）。
        // 重建的只是外层骨架；表单本体在 panelBody 里、由更稳定的 key 保留状态 ——
        // 所以草稿依旧不丢（见下面 panelBody 的 key）。
        shown
          ? h(
              "section",
              {
                class: ["activity-panel", { "is-closing": isClosing }],
                key: `${shown.id}:${openTick.value}`,
                id: `activity-panel-${shown.id}`,
                role: "tabpanel",
                "aria-labelledby": `activity-tab-${shown.id}`,
                style: toneStyle(shown.tone),
              },
              [tabsRow(true), panelBody(shown)],
            )
          : tabsRow(false),
        // 其余请求的内容体：隐藏但保持挂载
        ...list
          .filter((tab) => tab.id !== (expanded.value ?? closing.value))
          .map((tab) =>
            h(
              "div",
              {
                class: "activity-panel-host is-collapsed",
                key: tab.id,
                "aria-hidden": "true",
              },
              [panelBody(tab)],
            ),
          ),
      ]);
    };
  },
});
