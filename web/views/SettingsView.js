import { defineComponent, h, onMounted, onUnmounted, ref, watch } from "vue";
import { icon } from "../icons.js";
import { TOKEN_KEY } from "../api/event-stream.js";
import { postAction } from "../api/actions.js";
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

// 左侧一级分类导航；`tabs` 非空的分类在内容区顶部再渲染一条横向 tab 栏（二级）。
// `icon` 是导航按钮左侧的图标（用户 2026-09-25 要求四个一级各带一个）：常规用主题图标
//（该分类就是外观+行为），会话用对话气泡，定义用星花（技能/扩展/模板/定义文件这一堆资源），
// 关于用问号。不用 `layers`（已被中间过程组占用）与 `trace`（被「执行轨迹」页占用）。
// 合并口径（用户 2026-09-25）：外观 + 行为 = 「常规」；会话信息 + 连接与实例 = 「会话」；
// 技能 + 扩展 + 模板 + 定义 = 「定义」，其中原本的「定义」在二级里改名「其他」。
// 行为分类的标题暂不写「默认视图」（只有一个候选视图时不提供该项，见下方渲染处）。
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "常规",
    icon: "theme",
    tabs: [
      { id: "appearance", label: "外观", title: "外观" },
      { id: "behaviour", label: "行为", title: "折叠行为" },
    ],
  },
  {
    id: "conversation",
    label: "会话",
    icon: "chat",
    tabs: [
      { id: "session", label: "会话信息", title: "会话信息" },
      { id: "connection", label: "连接与实例", title: "连接与实例" },
      { id: "web", label: "Web 服务", title: "Web 服务与网关" },
    ],
  },
  {
    id: "definitions",
    label: "定义",
    icon: "spark",
    tabs: [
      { id: "skills", label: "技能", title: "技能" },
      { id: "extensions", label: "扩展", title: "扩展" },
      { id: "prompts", label: "模板", title: "Prompt 模板" },
      { id: "definition", label: "其他", title: "Agent 定义" },
    ],
  },
  { id: "about", label: "关于", title: "关于", icon: "help" },
];

// 一级分类（含无 tabs 的）；`id` 既可能是一级自己的 id，也可能是它某个二级的 id。
export function findSection(id) {
  return (
    SETTINGS_SECTIONS.find(
      (item) => item.id === id || item.tabs?.some((tab) => tab.id === id),
    ) || null
  );
}

// 点开一级分类时落在哪个内容页：有二级就落在第一项。
export const firstTabOf = (section) => section.tabs?.[0]?.id ?? section.id;

// 一级导航的键盘移动（↑/↓ 循环、Home/End）：按**分类**跳，落在该分类的第一项；
// 与当前内容页相同时返回 null。
export function nextSection(section, key) {
  const group = findSection(section);
  if (!group) return null;
  const index = SETTINGS_SECTIONS.indexOf(group);
  const move = (target) => {
    const item =
      SETTINGS_SECTIONS[
        (target + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
      ];
    const next = firstTabOf(item);
    return next === section ? null : next;
  };
  if (key === "ArrowDown") return move(index + 1);
  if (key === "ArrowUp") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(SETTINGS_SECTIONS.length - 1);
  return null;
}

// 二级 tab 栏的键盘移动（←/→ 循环、Home/End）；不在带二级的分类里时返回 null。
export function nextSettingsTab(section, key) {
  const tabs = findSection(section)?.tabs;
  if (!tabs) return null;
  const index = tabs.findIndex((tab) => tab.id === section);
  if (index < 0) return null;
  const move = (target) => {
    const next = tabs[(target + tabs.length) % tabs.length];
    return next.id === section ? null : next.id;
  };
  if (key === "ArrowRight") return move(index + 1);
  if (key === "ArrowLeft") return move(index - 1);
  if (key === "Home") return move(0);
  if (key === "End") return move(tabs.length - 1);
  return null;
}

// 「关于」页的浏览器与系统标签：只从 UA 里抽人看得懂的那一段，识别不出就退回去掉
// Mozilla/AppleWebKit 前缀的原始串（截断到 48 字），至少拷出来还有用。
const UA_PREFIX = /^(?:Mozilla|AppleWebKit|Gecko)\/[\d.]+\s*/;
const BROWSER_PATTERNS = [
  [/EdgA?\/([\d.]+)/, "Edge"],
  [/OPR\/([\d.]+)/, "Opera"],
  [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"],
  [/Chrome\/([\d.]+)/, "Chrome"],
  [/Firefox\/([\d.]+)/, "Firefox"],
  [/Version\/([\d.]+).*Safari/, "Safari"],
];
// 主版本号就够用了（Chromium 的完整串有 12 位，放进设置页只会把行挤到换行）。
export function browserLabel(userAgent) {
  const ua = String(userAgent || "");
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${String(match[1]).split(".")[0]}`;
  }
  const rest = ua.replace(UA_PREFIX, "").slice(0, 48);
  return rest || "未知浏览器";
}
const OS_PATTERNS = [
  [/Windows NT 10/, "Windows 10/11"],
  [/Windows NT 6\.[123]/, "Windows 7/8"],
  [/Windows/, "Windows"],
  [/Android ([\d.]+)/, "Android"],
  [/iPhone|iPad|iPod/, "iOS/iPadOS"],
  [/Mac OS X/, "macOS"],
  [/Linux|X11/, "Linux"],
];
export function osLabel(userAgent) {
  const ua = String(userAgent || "");
  for (const [pattern, name] of OS_PATTERNS) {
    if (pattern.test(ua)) return name;
  }
  return "未知系统";
}
// 使用说明（用户 2026-09-25 选定要展示）：只写代码里真的做了的事。
const ABOUT_NOTES = [
  "输入框：Enter 发送，Shift+Enter 换行；模型在跑时同一个按钮变成「停止」。",
  "输入 / 弹命令菜单：↑/↓ 选择，Tab 或 Enter 补全，Esc 关闭。",
  "顶部页面 tab 与设置页导航都能用键盘：一级分类 ↑/↓，分类内的横向 tab ←/→，Home/End 跳到首尾。",
  "内容列宽：拖内容列两侧的把手调宽度，或把手聚焦后用 ←/→ 微调（按住 Shift 是大步长）。",
  "在 TUI 里执行 /reload 会重载扩展并让页面自动刷新；「会话 → 连接与实例」里的「重新载入页面」只是手动重拉一次快照。",
  "断线会自动重连；页面切到后台再切回时会立即重同步一次，不会停在旧快照上。",
];

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
    // `section` 存的是**内容页 id**（可能是二级 tab 的 id），一级高亮由 findSection 反查；
    // 这样下方 body() 仍然只按内容页分支，不随分类合并而改。
    // 凭证换代后会自动重载页面；先记下当前面板，下次挂载时回到同一页（否则会被丢回「常规」）。
    // 必须带时间戳：路由是 memory history，重载后落在对话页，SettingsView 要等用户自己点开才会
    // 挂载（所以不会马上消费掉这个键）；不限时的话半小时后随手开设置会莫名落在 Web 服务。
    const RETURN_KEY = "atom-settings-return";
    const RETURN_TTL = 20000;
    const restoredSection = (() => {
      try {
        const value = globalThis.sessionStorage?.getItem?.(RETURN_KEY);
        if (!value) return null;
        globalThis.sessionStorage?.removeItem?.(RETURN_KEY);
        const mark = value.indexOf("|");
        if (mark < 0) return null;
        const at = Number(value.slice(0, mark));
        if (!Number.isFinite(at) || Date.now() - at > RETURN_TTL) return null;
        const id = value.slice(mark + 1);
        // 只认还存在的面板 id：分类改过名或被删了就别硬套旧值。
        return SETTINGS_SECTIONS.some(
          (item) =>
            item.id === id || (item.tabs || []).some((tab) => tab.id === id),
        )
          ? id
          : null;
      } catch {
        return null;
      }
    })();
    const section = ref(restoredSection || firstTabOf(SETTINGS_SECTIONS[0]));
    const rememberSection = () => {
      try {
        globalThis.sessionStorage?.setItem?.(
          RETURN_KEY,
          `${Date.now()}|${section.value}`,
        );
      } catch {
        /* 写不进去就回到默认面板，不影响跳转 */
      }
    };
    // Web 设置（「会话 → Web 服务」）：端口是草稿，点「保存」才下发 configure_web；
    // 固定凭证开关是即时下发的（后端会当场换凭证）。后端写盘后广播 webConfig，快照一到就把草稿对回真实值。
    const webPorts = ref({ port: 31359, lanPort: 31360 });
    const webFixed = ref(false);
    // 自动恢复（重启 pi 后把上次显式开着的 Web 接回来）：默认开。
    const webAutoServe = ref(true);
    const webSaving = ref(false);
    const webError = ref("");
    // 凭证换代后的新地址：本页面手里的凭证已经作废，得告诉用户去哪儿重开。
    const webNotice = ref("");
    // 自动跳转已排队（区别于“跳不了、只能手动开新地址”那种兑底提示）。
    const webJumping = ref(false);
    watch(
      () => session.webConfig,
      (config) => {
        if (!config) return;
        webPorts.value = { port: config.port, lanPort: config.lanPort };
        webFixed.value = config.fixedToken === true;
        webAutoServe.value = config.autoServe !== false;
      },
      { immediate: true },
    );
    const postWeb = (payload) =>
      postAction(
        globalThis.sessionStorage?.getItem?.(TOKEN_KEY) || "",
        { type: "configure_web", sessionId: session.sessionId, ...payload },
      );
    /**
     * 把页面跳到换代后的地址。两种情况必须分开处理：
     *   · 路径也变了（换 host / 端口 / 会话短码）：直接导航过去。
     *   · **只有 `#凭证` 变了**：给 `location.href` 赋值是同文档导航，浏览器不会重新拉文档，
     *     而服务已在背后重启、旧凭证已失效，页面会停在半死状态。所以先把地址栏里的片段抹掉
     *     （新凭证已在 sessionStorage 里，`consumeToken` 没有片段时读的就是这个键）、再强制 reload。
     *     不先把片段清掉就 reload 会拿旧凭证去鉴权（`consumeToken` 优先读片段）。
     */
    const reopenAtNewUrl = (url) => {
      const location = globalThis.location;
      if (!location) return;
      let target = null;
      try {
        target = new URL(url, location.href);
      } catch {
        return;
      }
      if (
        target.origin !== location.origin ||
        target.pathname !== location.pathname
      ) {
        location.assign(target.href);
        return;
      }
      if (globalThis.history?.replaceState) {
        globalThis.history.replaceState(
          null,
          "",
          `${location.pathname}${location.search}`,
        );
        location.reload();
        return;
      }
      // 没 replaceState 的老浏览器：只能把新地址（带新凭证）挂上去让用户自己刷新。
      location.replace(target.href);
    };
    /**
     * 凭证换代：后端把新凭证放在动作响应里回来（调用方此刻还是已鉴权的）。
     * 先写回 sessionStorage（重载后 `consumeToken` 没有 # 片段就读这个键），再自动跳到新地址；
     * 写不进去（隐私模式等）就不跳，否则 reload 后拿不到凭证，只能手动用新地址开。
     */
    const adoptToken = (body) => {
      if (!body?.token) return;
      webNotice.value = body.url || "";
      try {
        globalThis.sessionStorage?.setItem?.(TOKEN_KEY, body.token);
      } catch {
        webJumping.value = false;
        return;
      }
      // 留一点时间让新地址先显示出来（服务已经重启，旧凭证接下来会失效）。
      rememberSection();
      webJumping.value = true;
      globalThis.setTimeout?.(() => reopenAtNewUrl(body.url), 1200);
    };
    const clampPort = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return webPorts.value.port;
      return Math.min(65535, Math.max(1, Math.round(number)));
    };
    const webDirty = () => {
      const config = session.webConfig;
      return (
        Boolean(config) &&
        (config.port !== webPorts.value.port ||
          config.lanPort !== webPorts.value.lanPort)
      );
    };
    const saveWebPorts = async () => {
      webSaving.value = true;
      webError.value = "";
      try {
        await postWeb({
          port: webPorts.value.port,
          lanPort: webPorts.value.lanPort,
        });
      } catch (error) {
        webError.value = `保存失败：${error.message}`;
      } finally {
        webSaving.value = false;
      }
    };
    // 固定凭证开关：下发后后端会重启服务换凭证，新凭证从响应里接过来。
    const saveFixedToken = async (value) => {
      webSaving.value = true;
      webError.value = "";
      webFixed.value = value; // 先跟上下勾选，失败时下面回滚
      try {
        adoptToken(await postWeb({ fixedToken: value }));
      } catch (error) {
        webFixed.value = !value;
        webError.value = `保存失败：${error.message}`;
      } finally {
        webSaving.value = false;
      }
    };
    // 自动恢复开关：只写用户级配置、不动服务，所以不需要重新接凭证也不跳转。
    const saveAutoServe = async (value) => {
      webSaving.value = true;
      webError.value = "";
      webAutoServe.value = value; // 先跟上下勾选，失败时下面回滚
      try {
        await postWeb({ autoServe: value });
      } catch (error) {
        webAutoServe.value = !value;
        webError.value = `保存失败：${error.message}`;
      } finally {
        webSaving.value = false;
      }
    };
    const rotateKey = async () => {
      if (
        globalThis.confirm &&
        !globalThis.confirm("换一批固定凭证？所有会话的 Web 地址都会跟着换。")
      )
        return;
      webSaving.value = true;
      webError.value = "";
      try {
        adoptToken(
          await postAction(
            globalThis.sessionStorage?.getItem?.(TOKEN_KEY) || "",
            { type: "rotate_web_key", sessionId: session.sessionId },
          ),
        );
      } catch (error) {
        webError.value = `换密钥失败：${error.message}`;
      } finally {
        webSaving.value = false;
      }
    };
    const group = () =>
      findSection(section.value) || SETTINGS_SECTIONS[0];
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
    // 「关于」的运行环境行：浏览器/系统只取 UA 里看得懂的一段，视口与像素比取当前窗口值
    //（组件本身已监听 resize 重新取可用宽度，所以缩放窗口后这一页会跟着重画）。
    const environmentRows = () => {
      const nav = globalThis.navigator || {};
      const view = globalThis.window;
      const ua = String(nav.userAgent || "");
      const host = globalThis.location?.hostname || "";
      const local =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]";
      return rows([
        { label: "浏览器", value: browserLabel(ua) },
        { label: "操作系统", value: osLabel(ua) },
        { label: "界面语言", value: nav.language || "—" },
        {
          label: "视口",
          value: view ? `${view.innerWidth} × ${view.innerHeight}` : "—",
        },
        { label: "像素比", value: String(view?.devicePixelRatio ?? 1) },
        // 这一行读 `available`（resize 时更新的 ref）：一方面报障时真用得上，
        // 另一方面让缩放窗口能重画这一页（当前分支不读任何 resize 响应式数据时 Vue 不重渲染）。
        { label: "内容列可用宽度", value: `${available.value || 0} px` },
        {
          label: "安全上下文",
          value: globalThis.isSecureContext
            ? "是（可用异步剪贴板）"
            : "否（剪贴板走 execCommand）",
        },
        {
          label: "访问方式",
          value: local
            ? "本机 loopback"
            : host
              ? `局域网或端口转发（${host}）`
              : "未知",
        },
      ]);
    };
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
      if (section.value === "web") {
        const gateway = session.webConfig?.gateway;
        return [
          field(
            "网关端口",
            h(
              "div",
              { class: "setting-areas" },
              [
                { key: "port", label: "本机" },
                { key: "lanPort", label: "局域网" },
              ].map(({ key, label }) =>
                h("div", { class: "setting-inline", key }, [
                  h("span", { class: "setting-sublabel" }, label),
                  numberInput({
                    id: `setting-web-${key}`,
                    value: webPorts.value[key],
                    min: 1,
                    max: 65535,
                    onChange: (value) => {
                      const next = clampPort(value);
                      webPorts.value = { ...webPorts.value, [key]: next };
                      return next;
                    },
                  }),
                  h("span", { class: "page-hint" }, "端口"),
                ]),
              ),
            ),
            "多个 pi 进程共用一对固定端口：本机 /web 用一个、局域网 /web-wlan 用另一个，网关按 /<会话短码>/ 区分同时开着的多个会话。两个端口不能相同。",
          ),
          webError.value
            ? h("p", { class: "page-hint failure" }, webError.value)
            : null,
          h("div", { class: "setting-inline" }, [
            h(
              "button",
              {
                type: "button",
                class: "setting-action",
                disabled: webSaving.value || !webDirty(),
                onClick: saveWebPorts,
              },
              webSaving.value ? "保存中…" : "保存端口",
            ),
            h(
              "span",
              { class: "page-hint" },
              gateway
                ? `本会话当前跑在${gateway.lan ? "局域网" : "本机"}网关：端口 ${gateway.port}，路径 /${gateway.id}/`
                : "本会话未接入网关（未开 Web，或启动时退回直连地址）。",
            ),
          ]),
          h(
            "p",
            { class: "page-hint" },
            "改完在下一次执行 /web 或 /web-wlan 才生效；已打开的页面继续用原地址。配置写在 ~/.pi/atom/web/config.json，所有 pi 进程共用。",
          ),
          field(
            "固定凭证",
            toggle("同一会话每次都用同一个凭证", webFixed.value, (value) =>
              saveFixedToken(value),
            ),
            "默认关：每次开 Web 都换一个随机凭证（地址收藏不了）。打开后凭证 = sha256(本机密钥 + 会话 id)，同一个会话任何时候地址都一样（本机与局域网都是）。开关一改变代一次，本页会自动跳到新地址。",
          ),
          field(
            "自动恢复",
            toggle(
              "上次开着的会话，重启 pi 后自己把 Web 开回来",
              webAutoServe.value,
              (value) => saveAutoServe(value),
            ),
            "给「页面开在另一台机器上」兼的：那边的人回不到 TUI 执行 /web，所以重启 pi（不是 /reload）后服务端按上次的模式自己恢复（局域网就恢复成 0.0.0.0），同一个地址直接又能打开。只认上次显式执行过 /web、/web-wlan 的会话；执行一次 /web stop（或 /web-wlan stop）就是告诉下次不要再自动开。TUI 里对应的命令是 /web auto on | off | status。",
          ),
          webNotice.value
            ? h("div", { class: "setting-inline" }, [
                h("code", { class: "resource-path" }, webNotice.value),
                h(
                  "span",
                  { class: "page-hint" },
                  webJumping.value
                    ? "正在跳到新地址…"
                    : "没能自动跳转，请用上面的地址重新打开。",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "setting-action",
                    onClick: () => {
                      rememberSection();
                      reopenAtNewUrl(webNotice.value);
                    },
                  },
                  "立即跳转",
                ),
              ])
            : null,
          field(
            "凭证密钥",
            h("div", { class: "setting-inline" }, [
              h(
                "code",
                { class: "resource-path" },
                session.webConfig?.tokenKeyPath || "~/.pi/atom/web/token.key",
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "setting-action",
                  disabled: webSaving.value,
                  onClick: rotateKey,
                },
                "重新生成密钥",
              ),
            ]),
            "密钥只存在这台机器上：光知道会话 id 算不出凭证。点上面的按钮（或直接删掉这个文件）= 所有会话的固定凭证整体换代，泄露出去的老地址随即失效。",
          ),
        ];
      }
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
      if (section.value === "about")
        return [
          field(
            "版本与协议",
            rows([
              {
                label: "pi-atom-web 版本",
                value: session.extensionVersion || "未知（旧后端未上报）",
              },
              { label: "协议 schemaVersion", value: "1" },
              { label: "实例 ID", value: session.instanceId || "—" },
              { label: "服务地址", value: address() },
            ]),
            "扩展版本由服务端从 package.json 读出并随快照下发；改了版本号要重启扩展才会变。",
          ),
          field(
            "运行环境",
            environmentRows(),
            "浏览器与系统从 UA 解析，只到主版本号；视口与像素比是当前窗口值，缩放窗口后会刷新。",
          ),
          field(
            "使用说明",
            h(
              "ul",
              { class: "about-notes" },
              ABOUT_NOTES.map((note) => h("li", note)),
            ),
            "快捷键与重连行为都是页面里实际实现的；状态栏图标的含义看悬停浮层，设置项的含义看每项下方的说明。",
          ),
        ];
      return [
        // 只有一个候选视图（轨迹与上下文页暂时隐藏）时不提供这一项。
        DEFAULT_VIEWS.length > 1 &&
          field(
            "打开页面时显示",
            choice(
              DEFAULT_VIEWS.map((value) => ({
                value,
                label: VIEW_LABELS[value],
              })),
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
        // 一级按钮按**分类 id** 标记（一个分类可能对应多个内容页），所以拿反查到的分类去定位。
        event.currentTarget
          ?.querySelector?.(`[data-section="${findSection(next).id}"]`)
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
              "aria-selected": group().id === item.id,
              // 窄屏（手机）只显图标、文字会被 display:none 掉，而隐藏文本不再提供可访问名，
              // 所以 aria-label 一直挂着（与可见文字同串，对读屏无副作用）。
              "aria-label": item.label,
              "aria-controls": "settings-panel",
              tabindex: group().id === item.id ? 0 : -1,
              class: group().id === item.id ? "active" : null,
              onClick: () => {
                // 合并后的分类落在它自己的第一个二级页。
                section.value = firstTabOf(item);
              },
            },
            // 图标在前、文字在后；图标不带自己的颜色，跟随按钮文字色（未选中灰、选中强调色）。
            // 文字包成 span：窄屏（手机）只留图标，靠 .settings-nav-label 隐藏它。
            [
              h("span", { class: "settings-nav-icon" }, icon(item.icon)),
              h("span", { class: "settings-nav-label" }, item.label),
            ],
          ),
        ),
      );
    };
    // 二级横向 tab 栏（图二那个位置）：只在合并出来的分类里渲染。
    const tabsBar = () => {
      const tabs = group().tabs;
      if (!tabs) return null;
      const onKeydown = (event) => {
        const next = nextSettingsTab(section.value, event.key);
        if (!next) return;
        event.preventDefault();
        section.value = next;
        event.currentTarget
          ?.querySelector?.(`[data-tab="${next}"]`)
          ?.focus?.();
      };
      return h(
        "div",
        {
          class: "settings-tabs",
          role: "tablist",
          "aria-label": "分类内容",
          "aria-orientation": "horizontal",
          onKeydown,
        },
        tabs.map((item) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              key: item.id,
              id: `settings-tab-${item.id}`,
              "data-tab": item.id,
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
      group().tabs?.find((tab) => tab.id === section.value) || group();
    return () =>
      h("div", { class: "page settings-page" }, [
        nav(),
        h(
          "div",
          {
            class: "settings-body",
            id: "settings-panel",
            role: "tabpanel",
            "aria-labelledby": `settings-tab-${section.value}`,
          },
          [
            // 大标题**固定显示一级分类名**（用户 2026-09-25：「这里应该固定显示一级设置菜单的名字，比如『会话』」）：
            // 以前跟着二级 tab 走，于是会出现「会话」底下又写一个「会话信息」这种与 tab 重名的标题；
            // 当前在哪个二级由下方横向 tab 的高亮表示，标题不再重复一遍。tabs 里的 title 字段只当备注用。
            h("h3", { class: "settings-title" }, group().label),
            // 合并后的分类在标题下方再给一条横向 tab（会话 / 定义）。
            tabsBar(),
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
