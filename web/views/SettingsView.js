import { defineComponent, h, onMounted, onUnmounted, ref } from "vue";
import { icon } from "../icons.js";
import { TOKEN_KEY } from "../api/event-stream.js";
import { useSessionStore } from "../stores/session.js";
import {
  THEMES,
  DEFAULT_VIEWS,
  DEFAULT_SETTINGS,
  MAX_SAFE_AREA,
  useSettingsStore,
} from "../stores/settings.js";
import {
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  maxContentWidth,
} from "../components/layout/ColumnResizer.js";
import DetailRows from "../components/status/DetailRows.js";

const THEME_LABELS = { light: "浅色", dark: "深色", system: "跟随系统" };
const VIEW_LABELS = { chat: "对话", context: "上下文" };

// 左侧分类导航；右侧只渲染当前分类的内容。
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观", title: "外观" },
  { id: "session", label: "会话信息", title: "会话信息" },
  { id: "connection", label: "连接与实例", title: "连接与实例" },
  { id: "behaviour", label: "行为", title: "默认视图与折叠行为" },
  { id: "skills", label: "技能", title: "技能" },
  { id: "extensions", label: "扩展", title: "扩展" },
  { id: "prompts", label: "模板", title: "Prompt 模板" },
  { id: "definition", label: "定义", title: "Agent 定义" },
];

// 垂直分类导航的键盘移动（↑/↓ 循环、Home/End），目标与当前相同时返回 null。
export function nextSection(section, key) {
  const index = SETTINGS_SECTIONS.findIndex((item) => item.id === section);
  if (index < 0) return null;
  const move = (target) => {
    const next = (target + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    return next === index ? null : SETTINGS_SECTIONS[next].id;
  };
  if (key === "ArrowDown") return move(index + 1);
  if (key === "ArrowUp") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(SETTINGS_SECTIONS.length - 1);
  return null;
}

const field = (label, control, hint) =>
  h("div", { class: "setting-field" }, [
    h("div", { class: "setting-label" }, label),
    control,
    hint ? h("p", { class: "page-hint" }, hint) : null,
  ]);

// 分段选择器：一组互斥选项，用 aria-pressed 暴露当前值（主题、默认视图共用）。
const choice = (options, current, onSelect) =>
  h(
    "div",
    { class: "segmented", role: "group" },
    options.map((option) =>
      h(
        "button",
        {
          type: "button",
          key: option.value,
          class: current === option.value ? "active" : null,
          "aria-pressed": current === option.value,
          "data-choice": option.value,
          onClick: () => onSelect(option.value),
        },
        option.label,
      ),
    ),
  );

const toggle = (label, checked, onChange) =>
  h("label", { class: "setting-toggle" }, [
    h("input", {
      type: "checkbox",
      "data-toggle": label,
      checked: Boolean(checked),
      onChange: (event) => onChange(event.target.checked),
    }),
    h("span", label),
  ]);

// 数值输入：失焦或回车时提交，并把夹取后的结果写回输入框。
const numberInput = ({ id, value, min, max, step, onChange }) =>
  h("input", {
    type: "number",
    id,
    class: "setting-number",
    ...(min == null ? {} : { min: String(min) }),
    ...(max == null ? {} : { max: String(max) }),
    step: String(step ?? 1),
    value: String(value),
    onChange: (event) => {
      event.target.value = String(onChange(Number(event.target.value)));
    },
  });

// 滑块：拖动过程中实时生效（input），与数值输入共用同一个设置。
const slider = ({ id, value, min, max, step, label, onChange }) =>
  h("input", {
    type: "range",
    id,
    class: "setting-range",
    min: String(min),
    max: String(max),
    step: String(step ?? 1),
    value: String(value),
    "aria-label": label,
    onInput: (event) => onChange(Number(event.target.value)),
  });

// 还原按钮：统一用同一个图标，已处于默认值时禁用。
const resetButton = ({ label, disabled, onClick }) =>
  h(
    "button",
    {
      type: "button",
      class: "icon-button",
      "data-reset": label,
      "aria-label": label,
      title: label,
      disabled: Boolean(disabled),
      onClick,
    },
    [icon("reset")],
  );

export default defineComponent({
  name: "SettingsView",
  setup() {
    const session = useSessionStore(),
      settings = useSettingsStore();
    const section = ref(SETTINGS_SECTIONS[0].id);
    // 内容列宽度的上限跟当前视口有关，窗口变化时重新取一次。
    const available = ref(settings.availableWidth());
    const measure = () => {
      available.value = settings.availableWidth();
    };
    onMounted(() => globalThis.addEventListener?.("resize", measure));
    onUnmounted(() => globalThis.removeEventListener?.("resize", measure));
    const credential = () => {
      try {
        return globalThis.sessionStorage?.getItem(TOKEN_KEY)
          ? "已保存（仅本次标签页）"
          : "未保存";
      } catch {
        return "不可用";
      }
    };
    const address = () => {
      const location = globalThis.location;
      if (!location) return "—";
      return `${location.origin}${location.pathname || "/"}`;
    };
    const rows = (items) =>
      h(
        "div",
        { class: "detail-rows" },
        items.map((item) =>
          h("div", { class: "status-detail", key: item.label }, [
            h("span", item.label),
            h("strong", item.value),
          ]),
        ),
      );
    // 资源来源标签：global/project 固定文案，package 显示包名。
    const SOURCE_LABELS = { global: "全局", project: "项目" };
    const sourceLabel = (item) =>
      item.source === "package"
        ? item.sourceName || "包"
        : SOURCE_LABELS[item.source] || item.source;
    const formatSize = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
    // 技能/扩展/模板共用的资源列表（空状态用提示行占位）。
    const resourceList = (items, { emptyText, prefix = "" }) => {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return h("p", { class: "page-hint" }, emptyText);
      return h(
        "ul",
        { class: "resource-list" },
        list.map((item) =>
          h(
            "li",
            {
              class: "resource-item",
              key: `${item.source}|${item.path}|${item.name}`,
            },
            [
              h("div", { class: "resource-line" }, [
                h("strong", { class: "resource-name" }, `${prefix}${item.name}`),
                h("span", { class: "resource-chip" }, sourceLabel(item)),
              ]),
              item.description
                ? h("p", { class: "resource-desc" }, item.description)
                : null,
              item.path ? h("code", { class: "resource-path" }, item.path) : null,
            ],
          ),
        ),
      );
    };
    // 「定义」分类：上下文文件、系统提示、设置文件、packages、项目信任。
    const definitionSection = (def) => {
      if (!def)
        return [
          h(
            "p",
            { class: "page-hint" },
            "当前后端版本未提供定义信息，请在 TUI 执行 /reload 后重新打开设置。",
          ),
        ];
      return [
        field(
          "上下文文件",
          def.contextFiles.length
            ? rows(
                def.contextFiles.map((f) => ({
                  label: f.path,
                  value: formatSize(f.size),
                })),
              )
            : h("p", { class: "page-hint" }, "未加载任何上下文文件"),
          "按全局 → 顶层父目录 → 当前目录顺序加载；同目录 AGENTS.override.md 优先于 AGENTS.md / CLAUDE.md。",
        ),
        field(
          "系统提示",
          rows([
            {
              label: "替换默认（SYSTEM.md）",
              value: def.systemPromptFile || "未自定义",
            },
            {
              label: "追加到默认（APPEND_SYSTEM.md）",
              value: def.appendSystemPromptFile || "无",
            },
          ]),
          null,
        ),
        field(
          "设置文件",
          rows(
            def.settings.map((s) => ({
              label: s.path,
              value: s.exists ? "存在" : "不存在",
            })),
          ),
          null,
        ),
        field(
          "Packages",
          def.packages.length
            ? h(
                "div",
                { class: "chip-row" },
                def.packages.map((p) =>
                  h("span", { class: "resource-chip", key: p }, p),
                ),
              )
            : h("p", { class: "page-hint" }, "无"),
          "settings.json 的 packages 声明；包可携带扩展、技能、模板与主题。",
        ),
        field(
          "项目信任",
          h(
            "span",
            { class: def.projectTrusted ? "trust-ok" : "trust-off" },
            def.projectTrusted ? "已受信" : "未受信",
          ),
          "未受信时不加载项目级扩展与项目 settings.json 声明的资源。",
        ),
      ];
    };
    const body = () => {
      if (section.value === "appearance")
        return [
          field(
            "主题",
            choice(
              THEMES.map((value) => ({ value, label: THEME_LABELS[value] })),
              settings.theme,
              (value) => settings.setTheme(value),
            ),
            "跟随系统会随操作系统的深浅色实时切换。",
          ),
          field(
            "内容列宽度",
            h("div", { class: "setting-inline" }, [
              numberInput({
                id: "setting-content-width",
                value: settings.contentWidth,
                min: MIN_CONTENT_WIDTH,
                max: available.value,
                step: 10,
                onChange: (value) => settings.setContentWidth(value),
              }),
              h("span", { class: "page-hint" }, "px"),
              slider({
                id: "setting-content-width-range",
                value: settings.contentWidth,
                min: MIN_CONTENT_WIDTH,
                max: available.value,
                step: 10,
                label: "内容列宽度",
                onChange: (value) => settings.setContentWidth(value),
              }),
              resetButton({
                label: `还原默认宽度 ${DEFAULT_CONTENT_WIDTH}`,
                disabled: settings.contentWidth === DEFAULT_CONTENT_WIDTH,
                onClick: () => settings.resetContentWidth(),
              }),
            ]),
            "拖动对话区左右边界也能调整，双击手柄恢复默认。",
          ),
          field(
            "安全区",
            h(
              "div",
              { class: "setting-areas" },
              [
                { side: "top", label: "顶部" },
                { side: "bottom", label: "底部" },
              ].map(({ side, label }) => {
                const id = `setting-safe-area-${side}`;
                const current = () =>
                  side === "bottom"
                    ? settings.safeAreaBottom
                    : settings.safeAreaTop;
                return h("div", { class: "setting-inline", key: side }, [
                  h("span", { class: "setting-sublabel" }, label),
                  numberInput({
                    id,
                    value: current(),
                    min: 0,
                    max: MAX_SAFE_AREA,
                    onChange: (value) => settings.setSafeArea(side, value),
                  }),
                  h("span", { class: "page-hint" }, "px"),
                  slider({
                    id: `${id}-range`,
                    value: current(),
                    min: 0,
                    max: MAX_SAFE_AREA,
                    label: `${label}安全区`,
                    onChange: (value) => settings.setSafeArea(side, value),
                  }),
                  resetButton({
                    label: `还原${label}安全区`,
                    disabled: current() === DEFAULT_SETTINGS[`safeArea${side === "bottom" ? "Bottom" : "Top"}`],
                    onClick: () => settings.setSafeArea(side, 0),
                  }),
                ]);
              }),
            ),
            "为整个页面留出顶部/底部距离，避免手机刘海、系统状态栏、浏览器地址栏或底部工具栏遮挡内容（0 表示不留）。手机软键盘弹出时，底部安全区会自动让位，不会把输入框顶得更高。",
          ),
        ];
      if (section.value === "session")
        return [h(DetailRows, { session, kind: "session" })];
      if (section.value === "connection")
        return [
          rows([
            { label: "连接地址", value: address() },
            { label: "实例 ID", value: session.instanceId || "—" },
            { label: "连接状态", value: session.connection || "—" },
            { label: "连接凭证", value: credential() },
          ]),
          h(
            "button",
            {
              type: "button",
              class: "setting-action",
              onClick: () => globalThis.location?.reload?.(),
            },
            [icon("reload"), "重新载入页面"],
          ),
          h(
            "p",
            { class: "page-hint" },
            "扩展执行 /reload 后页面会自动刷新；此处用于手动重新拉取快照。",
          ),
        ];
      if (section.value === "skills")
        return [
          resourceList(session.agentResources?.skills, {
            emptyText: "未加载任何技能。",
          }),
          h(
            "p",
            { class: "page-hint" },
            "技能来自 pi 全局目录、项目 .pi/skills 与 npm 包；可用 /skill:名称 显式调用。",
          ),
        ];
      if (section.value === "extensions")
        return [
          resourceList(session.agentResources?.extensions, {
            emptyText: "未加载任何扩展。",
          }),
          h(
            "p",
            { class: "page-hint" },
            "按 pi 的目录发现规则扫描：全局 ~/.pi/agent/extensions、项目 .pi/extensions、settings.json 声明与 npm 包；未受信项目的项目级扩展不加载。",
          ),
        ];
      if (section.value === "prompts")
        return [
          resourceList(session.agentResources?.prompts, {
            emptyText: "未加载任何 Prompt 模板。",
            prefix: "/",
          }),
          h(
            "p",
            { class: "page-hint" },
            "Prompt 模板以斜杠命令调用，如 /模板名。",
          ),
        ];
      if (section.value === "definition")
        return definitionSection(session.agentResources?.definition);
      return [
        field(
          "打开页面时显示",
          choice(
            DEFAULT_VIEWS.map((value) => ({ value, label: VIEW_LABELS[value] })),
            settings.defaultView,
            (value) => settings.setDefaultView(value),
          ),
          "下次打开页面时生效，当前页可用上方 tab 直接切换。",
        ),
        toggle("自动折叠中间过程", settings.autoCollapse, (value) =>
          settings.setAutoCollapse(value),
        ),
        toggle("自动跟随最新消息", settings.autoFollow, (value) =>
          settings.setAutoFollow(value),
        ),
        h(
          "p",
          { class: "page-hint" },
          "关闭自动折叠后，一轮的思考与工具调用会一直展开；关闭自动跟随后，向上翻阅时不再被新消息拉回底部。",
        ),
      ];
    };
    const nav = () => {
      const onKeydown = (event) => {
        const next = nextSection(section.value, event.key);
        if (!next) return;
        event.preventDefault();
        section.value = next;
        event.currentTarget
          ?.querySelector?.(`[data-section="${next}"]`)
          ?.focus?.();
      };
      return h(
        "nav",
        {
          class: "settings-nav",
          role: "tablist",
          "aria-label": "设置分类",
          "aria-orientation": "vertical",
          onKeydown,
        },
        SETTINGS_SECTIONS.map((item) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              key: item.id,
              id: `settings-tab-${item.id}`,
              "data-section": item.id,
              "aria-selected": section.value === item.id,
              "aria-controls": "settings-panel",
              tabindex: section.value === item.id ? 0 : -1,
              class: section.value === item.id ? "active" : null,
              onClick: () => {
                section.value = item.id;
              },
            },
            item.label,
          ),
        ),
      );
    };
    const current = () =>
      SETTINGS_SECTIONS.find((item) => item.id === section.value) ||
      SETTINGS_SECTIONS[0];
    return () =>
      h("div", { class: "page settings-page" }, [
        nav(),
        h(
          "div",
          {
            class: "settings-body",
            id: "settings-panel",
            role: "tabpanel",
            "aria-labelledby": `settings-tab-${current().id}`,
          },
          [
            h("h3", { class: "settings-title" }, current().title),
            ...body(),
            section.value === "behaviour"
              ? h("div", { class: "page-actions" }, [
                  h(
                    "button",
                    {
                      type: "button",
                      onClick: () => settings.restoreDefaults(),
                    },
                    "恢复默认设置",
                  ),
                ])
              : null,
          ],
        ),
      ]);
  },
});
