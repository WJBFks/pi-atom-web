import { defineComponent, h, nextTick, ref, watch } from "vue";
import { icon } from "../../icons.js";
import { renderInlineMarkdown, stripInlineMarkdown } from "../../markdown.js";
import { useSessionStore } from "../../stores/session.js";
import { useDialogsStore } from "../../stores/dialogs.js";
import { useDialogRequests } from "../../stores/dialog-requests.js";
import { usePromptQueueActions } from "../../stores/prompt-queue-actions.js";
import { RequestView } from "../dialogs/RequestDock.js";
import PromptQueuePanel from "./PromptQueuePanel.js";
import { imageUrl } from "./image-files.js";

/**
 * 活动组件的 tab 模型。
 *
 * 每个活动组件给出一个 tab（有图标有名字），字段：
 * - `id`：稳定标识（用于展开状态与 React 式 diff）
 * - `priority`：浮点数，可正可负；**大的排在前面**（折叠态的长条在最上方，展开态的横排在最左）
 * - `arrivedAt`：到达时间戳；优先级相同时**先来的排在前面**
 * - `tone`：配色组（`{ color, background, border }`）
 * - `render`：大框内容（返回 VNode）
 *
 * 当前活动组件包括扩展请求，以及非空时出现的 Prompt 队列 —— 但队列**不是一个 tab**：
 * `strip: true` 的条目是折叠态里「一条消息一长条」的入口（`queueItem` 带着那条消息，
 * 行右侧另有「引导/排队」与「删除」两个按钮）；`panelOnly: true` 的那一个才是队列面板本体，
 * 只在展开态的大框顶部出现。两者分工：`rowTabs(false)` 滤掉 panelOnly、`rowTabs(true)` 滤掉 strip；
 * 长条自己的 `aria-controls` 与点击目标都指向 `PROMPT_QUEUE_PANEL_ID`，
 * 所以 `expanded` 里存的永远是面板 tab 的 id（某条长条消失也不会把面板带走）。
 */
export const EXTENSION_REQUEST_PRIORITY = 1000;
export const PROMPT_QUEUE_PRIORITY = 500;
/**
 * 队列在**折叠态**不再合成一个短 tab，而是一条一个长条（用户 2026-09-29）：
 * 引导（steer）整组在前、排队（followUp）在其后，同组内后到达的放下面；
 * 只平铺最靠前的 5 条，剩下的收进一条「还有 N 条」（优先级比单条低）。
 * 长条与「还有 N 条」都展开**同一份整体队列面板**（长条自用的大框 id = `prompt-queue`）。
 */
export const QUEUE_STRIP_STEER_PRIORITY = 620;
export const QUEUE_STRIP_FOLLOW_PRIORITY = 610;
export const QUEUE_STRIP_MORE_PRIORITY = 590;
export const QUEUE_STRIP_LIMIT = 5;
/** 队列面板的归属 tab（长条本身只是入口，展开后顶部只显示这一个 tab）。 */
export const PROMPT_QUEUE_PANEL_ID = "prompt-queue";
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

/** 队列面板那一 tab 的标题：数量用行内代码徽片（与轮次标题「思考`3` · 工具调用`5`」同一套语言；
 *  tab 标题走 inline Markdown，所以这里直接写反引号、由渲染端解析）。 */
const QUEUE_TAB_LABEL = (count) => "消息队列 `" + count + "`";

/**
 * 按 package 定制的 tab 外观（标题/图标/配色）。
 * 未列出的 package（以及不带 packageId 的通用请求）沿用上面的默认紫。
 * 同一档明度、对比度 ≈ 4.5:1。
 */
export const PACKAGE_ACTIVITY_LOOK = {
  "@juicesharp/rpiv-ask-user-question": {
    label: "提问",
    // 提问的专属图标（由 package 档案登记进图标表，见 §21）；`help` 回到只用「关于」页。
    icon: "ask-question",
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
 * 按优先级降序排列（大的在前：折叠态在上、展开态在左）；优先级相等时按到达时间升序。
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
 * tablist 的键盘移动：折叠态纵向堆叠走上下键、展开态横行走左右键，都循环、Home/End。
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
  if (key === "ArrowRight" || key === "ArrowDown") return move(index + 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(enabled.length - 1);
  return null;
}

const queueTexts = (queue, kind) =>
  (queue?.[kind] || []).map((item) =>
    typeof item === "string"
      ? item
      : `${item?.id || ""}:${item?.text ?? ""}`,
  );

/**
 * 只把新增和修改视为需要提醒的变化。纯删除（包括 Pi 消费队列）
 * 不抢焦点；跨队列转换只提醒消息移入的目标队列。
 */
function changedItemIndexes(previous, current) {
  let start = 0;
  while (start < previous.length && previous[start] === current[start]) start += 1;
  let beforeEnd = previous.length;
  let afterEnd = current.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    previous[beforeEnd - 1] === current[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return Array.from({ length: Math.max(0, afterEnd - start) }, (_, offset) =>
    start + offset,
  );
}

export function queueAttentionItems(previous, current) {
  const beforeCount = Number(previous?.count || 0);
  const afterCount = Number(current?.count || 0);
  if (afterCount < beforeCount) return [];
  const kinds = ["steering", "followUp"];
  const targets = (selected) =>
    selected.flatMap((kind) =>
      changedItemIndexes(
        queueTexts(previous, kind),
        queueTexts(current, kind),
      ).map((index) => `${kind}:${index}`),
    );
  if (afterCount > beforeCount) {
    const grown = kinds.filter(
      (kind) => queueTexts(current, kind).length > queueTexts(previous, kind).length,
    );
    return targets(grown);
  }
  const movedInto = kinds.filter(
    (kind) => queueTexts(current, kind).length > queueTexts(previous, kind).length,
  );
  if (movedInto.length) return targets(movedInto);
  return targets(kinds.filter(
    (kind) =>
      JSON.stringify(queueTexts(previous, kind)) !==
      JSON.stringify(queueTexts(current, kind)),
  ));
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
    const queueFlash = ref({ items: [], nonce: 0 });
    // 长条右侧的「引导/排队」与「删除」直接改队列；与面板里的同类操作共用同一份 store
    const queueActions = usePromptQueueActions(props.token, (error) =>
      props.onError?.(error),
    );

    /**
     * 每个未完成的扩展请求各占一个 tab；Prompt 队列则每条消息各占一条长条（`strip`），
     * 外加一个只在展开态出现的队列面板 tab（`panelOnly`）。
     * 队列变化**不再自动展开**（用户 2026-09-29），只让改动的那一条闪两下。
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
      const queue = [
        ...session.promptQueue.steering.map((item) => ({ item, steer: true })),
        ...session.promptQueue.followUp.map((item) => ({ item, steer: false })),
      ];
      if (!queue.length) return requestTabs;
      // 队列面板本体那一 tab：只在展开态的大框顶部出现（折叠态由下面的长条占位）
      requestTabs.push({
        id: PROMPT_QUEUE_PANEL_ID,
        label: QUEUE_TAB_LABEL(queue.length),
        icon: "mode",
        priority: PROMPT_QUEUE_PRIORITY,
        arrivedAt: Number.MAX_SAFE_INTEGER,
        tone: PROMPT_QUEUE_TONE,
        queue: true,
        autoOpen: false,
        panelOnly: true,
      });
      // 折叠态：一条消息一长条（用户 2026-09-29）；引导整组在前、排队在其后，
      // 同组内按到达顺序（后到的在下面）；只平铺最靠前的 QUEUE_STRIP_LIMIT 条。
      queue.slice(0, QUEUE_STRIP_LIMIT).forEach(({ item, steer }, index) => {
        requestTabs.push({
          id: `queue:${item.id}`,
          // 长条标题就是这条消息的正文（plain = 按纯文本渲染，不当 inline Markdown 解析）
          label: String(item.text || "").trim() || "（仅图片）",
          plain: true,
          // 引导与排队用不同图标（引导 = send、向上送进当前轮；排队 = mode、一排待执行）
          icon: steer ? "send" : "mode",
          priority: steer
            ? QUEUE_STRIP_STEER_PRIORITY
            : QUEUE_STRIP_FOLLOW_PRIORITY,
          arrivedAt: index,
          tone: PROMPT_QUEUE_TONE,
          queueItem: item,
          strip: true,
          autoOpen: false,
        });
      });
      const rest = queue.length - Math.min(queue.length, QUEUE_STRIP_LIMIT);
      if (rest > 0)
        requestTabs.push({
          id: "queue:more",
          label: `还有 ${rest} 条`,
          icon: "mode",
          priority: QUEUE_STRIP_MORE_PRIORITY,
          arrivedAt: 0,
          tone: PROMPT_QUEUE_TONE,
          strip: true,
          autoOpen: false,
        });
      return requestTabs;
    };

    const copyQueue = () => ({
      count: session.promptQueue.count,
      steering: queueTexts(session.promptQueue, "steering"),
      followUp: queueTexts(session.promptQueue, "followUp"),
    });
    let previousQueue = copyQueue();

    watch(
      () =>
        JSON.stringify([
          session.promptQueue.revision,
          session.promptQueue.count,
          queueTexts(session.promptQueue, "steering"),
          queueTexts(session.promptQueue, "followUp"),
        ]),
      () => {
        const currentQueue = copyQueue();
        const items = queueAttentionItems(previousQueue, currentQueue);
        previousQueue = currentQueue;
        if (!items.length) return;
        queueFlash.value = {
          items,
          nonce: queueFlash.value.nonce + 1,
        };
        // 不再自动展开（用户 2026-09-29）：只让改动的那一条闪两下，
        // 面板开合状态保持用户留下的那个样子。
      },
    );

    // 可见 tab：按优先级降序（大的在前 = 折叠态在最上方、展开态在最左），优先级相等时先到的在前
    const visible = () => sortActivityTabs(tabs());

    /**
     * 某一行实际要渲染的 tab：折叠态那一行是「请求 + 每条队列长条」（不含面板 tab），
     * 展开态那一行是「请求 + 队列面板 tab」（不含长条）。键盘导航也按当前这一行走。
     */
    const rowTabs = (inPanel) =>
      sortActivityTabs(
        tabs().filter((tab) => (inPanel ? !tab.strip : !tab.panelOnly)),
      );

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
        if (closing.value !== id) return;
        closing.value = null;
        // tab 行**这一刻**才从大框顶部搬回输入卡上方（节点被重建）：早于这里的聚焦
        // 都会随旧节点一起失效（实测 activeElement 掉回 body），所以焦点归还在这里做。
        nextTick(() => focusTab(id));
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

    /**
     * 把焦点交给指定 tab（切换后原节点会被重建，必须重新聚焦）。
     * 必须挑**可见**的那一个：同一个 tab 在 DOM 里可能同时存在两份（展开态在大框顶部、
     * 收起态在输入卡上方；折叠时 `closing` 还会让大框多留 160ms），
     * `querySelector` 拿到的第一个可能是隐藏副本，focus() 就静默失效。
     */
    const focusTab = (id) => {
      if (!id) return;
      const nodes = [
        ...(host.value?.querySelectorAll(`[data-activity-tab="${id}"]`) || []),
      ];
      // 只在展开态出现的 tab（如队列面板本体）折叠后整行里根本没它，
      // 退回聚焦行里第一个可见项，否则焦点掉回 body、键盘导航会断。
      const fallback = [
        ...(host.value?.querySelectorAll(".activity-tabs [data-activity-tab]") || []),
      ].find((item) => item.offsetParent !== null);
      const node =
        nodes.find((item) => item.offsetParent !== null) || nodes[0] || fallback;
      node?.focus?.();
    };

    /**
     * 点 tab：
     * - 面板已展开且点的就是当前展示的那一项 → **折叠整个活动组件栏**
     *   （再点一下自己 = 收起，与常见的 tab 栏直觉一致）；
     * - 否则只切换「当前大框展示哪个活动组件」（从收起态进入展开态）。
     * 行尾的最小化按钮与键盘 Esc 仍然是另外两条折叠入口。
     */
    const select = (id) => {
      focused.value = id;
      if (expanded.value === id) {
        collapse(); // 焦点归还给 tab 由 collapse 的退场动画回调负责
        return;
      }
      const wasCollapsed = expanded.value === null;
      if (wasCollapsed) openTick.value += 1;
      closing.value = null; // 取消可能还在播的退场动画
      expanded.value = id;
      // 从收起态进入展开态时会重建 tab 节点（tab 行换到面板内），
      // 原节点被移除后焦点会掉到 body，所以补一次聚焦。
      if (wasCollapsed) queueMicrotask(() => focusTab(id));
    };

    const onKeydown = (event, list) => {
      if (event.key === "Escape" && expanded.value) {
        event.preventDefault();
        collapse();
        return;
      }
      if (!list.length) return;
      const current =
        focused.value ?? expanded.value ?? list[0]?.id ?? null;
      const next = nextActivityTab(list, current, event.key);
      if (!next) return;
      event.preventDefault();
      focused.value = next;
      // 方向键只移动焦点；已有展开的大框则跟随切换（与鼠标点击一致）
      if (expanded.value) expanded.value = next;
      // 必须等重渲染后再聚焦：此刻 DOM 可能仍是被替换掉的旧节点
      nextTick(() => focusTab(next));
    };

    /** 长条自己不算面板本体，它展开的是队列面板那一个大框。 */
    const panelIdOf = (tab) => (tab.strip ? PROMPT_QUEUE_PANEL_ID : tab.id);

    /**
     * tab 的渲染：收起态在输入卡上方（队列是一条一长条），展开态整体升到大框顶部，两者共用。
     * 队列长条额外带：正文前的图片缩略图，以及行右侧依次的「引导 / 排队」文字按钮与「删除」图标按钮
     * —— 两个按钮是 tab 按钮的**兄弟节点**，不能嵌在 `role=tab` 里。
     */
    const tabNode = (tab) => {
      const item = tab.queueItem;
      const steer = item?.kind === "steer";
      const text = String(item?.text || "").trim() || "（仅图片）";
      const images = item ? item.images || [] : [];
      return h(
        "div",
        {
          class: [
            "activity-tab",
            { "is-active": expanded.value === tab.id, "is-strip": !!tab.strip },
          ],
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
              "aria-controls": `activity-panel-${panelIdOf(tab)}`,
              tabindex: (expanded.value ?? focused.value) === tab.id ? 0 : -1,
              // 浮层只能放纯文本：否则看到 `消息队列 \`3\`` 这种带反引号的源码。
              title: tab.plain ? tab.label : stripInlineMarkdown(tab.label),
              onClick: () => select(panelIdOf(tab)),
              onFocus: () => {
                focused.value = tab.id;
              },
            },
            [
              h("span", { class: "activity-tab-icon" }, icon(tab.icon)),
              // 行左侧的类型标记：这条现在是引导还是排队（与右侧按钮的**目标**类型相反）
              item
                ? h(
                    "span",
                    { class: ["activity-tab-kind", steer ? "is-steer" : "is-follow"] },
                    steer ? "引导" : "排队",
                  )
                : null,
              images.length
                ? h(
                    "span",
                    { class: "activity-tab-images" },
                    images.slice(0, 2).map((image, index) =>
                      h("img", {
                        key: index,
                        class: "activity-tab-image",
                        src: imageUrl(image),
                        alt: `图片 ${index + 1}`,
                      }),
                    ),
                  )
                : null,
              // 标题允许 inline Markdown（`**粗体**` 等）：已经过 DOMPurify 白名单，
              // 只放行行内标签且属性全清。**队列长条是用户正文，走纯文本**（`plain`）。
              tab.plain
                ? h("span", { class: "activity-tab-label" }, tab.label)
                : h("span", {
                    class: "activity-tab-label",
                    innerHTML: renderInlineMarkdown(tab.label),
                  }),
            ],
          ),
          // 行右侧依次：转类型（引导 ↔ 排队）与删除
          ...(item
            ? [
                h(
                  "button",
                  {
                    type: "button",
                    class: "activity-tab-action",
                    disabled: !!queueActions.changing.value,
                    title: steer ? "改为排队" : "改为引导",
                    "aria-label": (steer ? "改为排队：" : "改为引导：") + text,
                    onClick: () =>
                      queueActions.mutate(
                        item,
                        steer ? "followUp" : "steer",
                      ),
                  },
                  steer ? "改为排队" : "改为引导",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "activity-tab-action is-icon",
                    disabled: !!queueActions.changing.value,
                    title: "删除",
                    "aria-label": "删除：" + text,
                    onClick: () => queueActions.remove(item),
                  },
                  icon("close"),
                ),
              ]
            : []),
        ],
      );
    };

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
      /** 某个活动组件的内容体（请求本体；队列长条不走这里，它们共用面板 tab 的那一份）。 */
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
                  flash: queueFlash.value,
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

      const tabsRow = (inPanel) => {
        // 行内只渲染属于这一行的 tab：折叠态 = 请求 + 队列长条，展开态 = 请求 + 队列面板 tab
        const rowList = rowTabs(inPanel);
        return h(
          "div",
          {
            class: inPanel
              ? "activity-tabs activity-tabs-in-panel"
              : "activity-tabs",
            role: "tablist",
            "aria-label": "活动组件",
            // 折叠态是纵向堆叠的长条，展开态那行仍是横向
            "aria-orientation": inPanel ? "horizontal" : "vertical",
            onKeydown: (event) => onKeydown(event, rowList),
          },
          inPanel
            ? [
                ...rowList.map((tab) => tabNode(tab)),
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
            : rowList.map((tab) => tabNode(tab)),
        );
      };

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
        // 其余请求的内容体：隐藏但保持挂载（**队列长条不算本体**，它们共用面板 tab 那一份，
        // 每条各挂一份会把队列面板复制 N 遍）
        ...list
          .filter(
            (tab) =>
              !tab.strip && tab.id !== (expanded.value ?? closing.value),
          )
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
