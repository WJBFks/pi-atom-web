import { defineStore } from "pinia";
import {
  DEFAULT_CONTENT_WIDTH,
  clampContentWidth,
  maxContentWidth,
  readStoredContentWidth,
  storeContentWidth,
} from "../components/layout/ColumnResizer.js";

// 主题沿用原有的 atom-theme（值 light/dark/system），其余偏好放在 atom-settings，
// 内容列宽度继续由 ColumnResizer 的 atom-content-width 负责，避免两套记忆打架。
export const THEME_STORAGE_KEY = "atom-theme";
export const SETTINGS_STORAGE_KEY = "atom-settings";
export const THEMES = ["light", "dark", "system"];
// 执行轨迹将来是独立页面（tab 暂不可选中），因此暂不作为默认视图。
export const DEFAULT_VIEWS = ["chat", "context"];
// 安全区：为内容留出的顶部/底部距离（px），用于避开手机刘海、系统状态栏与浏览器工具栏。
export const MAX_SAFE_AREA = 240;
export const DEFAULT_SETTINGS = {
  theme: "light",
  defaultView: "chat",
  autoCollapse: true,
  autoFollow: true,
  safeAreaTop: 0,
  safeAreaBottom: 0,
};

export function clampSafeArea(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.round(number), MAX_SAFE_AREA);
}

// 手机软键盘弹出时底部已经被键盘占住：此时让出底部安全区，避免把输入框顶得更高。
export function isEditableNode(node) {
  if (!node) return false;
  return (
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.isContentEditable === true
  );
}

export function isCoarsePointer(matchMedia = globalThis.matchMedia) {
  return typeof matchMedia === "function"
    ? Boolean(matchMedia("(pointer: coarse)")?.matches)
    : false;
}

// 只有「触屏设备 + 焦点在某个人可输入元素上」才认为软键盘占着底部；
// 桌面浏览器里的输入框不触发，浏览器工具栏伸缩也不会误判。
export function shouldYieldBottomSafeArea(activeElement, coarsePointer) {
  return Boolean(coarsePointer && isEditableNode(activeElement));
}

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_SETTINGS.theme;
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    defaultView: DEFAULT_VIEWS.includes(source.defaultView)
      ? source.defaultView
      : DEFAULT_SETTINGS.defaultView,
    autoCollapse: source.autoCollapse !== false,
    autoFollow: source.autoFollow !== false,
    safeAreaTop: clampSafeArea(source.safeAreaTop),
    safeAreaBottom: clampSafeArea(source.safeAreaBottom),
  };
}

export function resolveDark(theme, systemDark) {
  return theme === "dark" || (theme === "system" && Boolean(systemDark));
}

const readItem = (storage, key) => {
  try {
    return storage?.getItem ? storage.getItem(key) : null;
  } catch {
    return null;
  }
};

export function readStoredSettings(storage = globalThis.localStorage) {
  let parsed = {};
  try {
    parsed = JSON.parse(readItem(storage, SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    parsed = {};
  }
  const settings = normalizeSettings(parsed);
  const theme = readItem(storage, THEME_STORAGE_KEY);
  return {
    ...settings,
    theme: theme == null ? DEFAULT_SETTINGS.theme : normalizeTheme(theme),
  };
}

export function storeSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        defaultView: settings.defaultView,
        autoCollapse: settings.autoCollapse !== false,
        autoFollow: settings.autoFollow !== false,
        safeAreaTop: clampSafeArea(settings.safeAreaTop),
        safeAreaBottom: clampSafeArea(settings.safeAreaBottom),
      }),
    );
  } catch {
    /* 存储不可用时仅本次生效 */
  }
}

export function storeTheme(theme, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(THEME_STORAGE_KEY, normalizeTheme(theme));
  } catch {
    /* 同上 */
  }
}

// 系统主题监听不进 state：MediaQueryList 不需要响应式，也避免 Pinia 包装它。
let systemQuery;
let systemListener;
let widthListener;
let keyboardListener;

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    ...readStoredSettings(),
    contentWidth: readStoredContentWidth(),
    systemDark: false,
    // 软键盘是否占着底部（只影响底部安全区的实际生效值）
    keyboardOpen: false,
  }),
  getters: {
    dark: (state) => resolveDark(state.theme, state.systemDark),
    // 键盘弹出时实际生效的底部安全区（配置值不变）
    appliedSafeAreaBottom: (state) =>
      state.keyboardOpen ? 0 : state.safeAreaBottom,
  },
  actions: {
    load() {
      this.watchSystemTheme();
      this.watchContentWidth();
      this.watchKeyboard();
      this.applyTheme();
      this.applyContentWidth();
      this.applySafeArea();
    },
    // 监听焦点变化：手机上点到输入框就认为是软键盘占住了底部。
    watchKeyboard() {
      const target = globalThis.document;
      if (!target?.addEventListener) return;
      if (keyboardListener) {
        target.removeEventListener("focusin", keyboardListener);
        target.removeEventListener("focusout", keyboardListener);
      }
      keyboardListener = () => {
        this.setKeyboardOpen(
          shouldYieldBottomSafeArea(target.activeElement, isCoarsePointer()),
        );
      };
      target.addEventListener("focusin", keyboardListener);
      target.addEventListener("focusout", keyboardListener);
    },
    setKeyboardOpen(value) {
      const next = Boolean(value);
      if (next === this.keyboardOpen) return;
      this.keyboardOpen = next;
      this.applySafeArea();
    },
    // 拖动列宽手柄也会改同一个记忆值，用同名事件让设置页跟着刷新。
    watchContentWidth() {
      if (typeof globalThis.addEventListener !== "function") return;
      if (widthListener)
        globalThis.removeEventListener?.("atom-content-width", widthListener);
      widthListener = () => {
        this.contentWidth = readStoredContentWidth();
      };
      globalThis.addEventListener("atom-content-width", widthListener);
    },
    publishWidth() {
      globalThis.dispatchEvent?.(
        new CustomEvent("atom-content-width", { detail: this.contentWidth }),
      );
    },
    watchSystemTheme() {
      if (typeof globalThis.matchMedia !== "function") return;
      if (systemQuery && systemListener)
        systemQuery.removeEventListener?.("change", systemListener);
      systemQuery = globalThis.matchMedia("(prefers-color-scheme: dark)");
      this.systemDark = Boolean(systemQuery.matches);
      systemListener = (event) => {
        this.systemDark = Boolean(event.matches);
        this.applyTheme();
      };
      systemQuery.addEventListener?.("change", systemListener);
    },
    applyTheme() {
      globalThis.document?.documentElement?.classList.toggle("dark", this.dark);
    },
    setTheme(value) {
      this.theme = normalizeTheme(value);
      storeTheme(this.theme);
      this.applyTheme();
    },
    availableWidth() {
      const scroll = globalThis.document?.querySelector?.("#scroll");
      return (
        scroll?.clientWidth || globalThis.innerWidth || DEFAULT_CONTENT_WIDTH
      );
    },
    applyContentWidth() {
      globalThis.document?.documentElement?.style?.setProperty(
        "--content-width",
        `${this.contentWidth}px`,
      );
    },
    setContentWidth(value) {
      const wanted = Number(value);
      const clamped = clampContentWidth(
        Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_CONTENT_WIDTH,
        this.availableWidth(),
      );
      this.contentWidth = clamped;
      storeContentWidth(clamped);
      this.applyContentWidth();
      this.publishWidth();
      return clamped;
    },
    resetContentWidth() {
      this.contentWidth = Math.min(
        DEFAULT_CONTENT_WIDTH,
        maxContentWidth(this.availableWidth()),
      );
      storeContentWidth(this.contentWidth);
      this.applyContentWidth();
      this.publishWidth();
      return this.contentWidth;
    },
    persist() {
      storeSettings(this);
    },
    // 安全区：写成 --safe-area-top/-bottom，由 .layout 的 padding 消费
    // （整个窗口因此内缩，工具栏不会钻到状态栏下、输入框不会被底部工具栏盖住）。
    applySafeArea() {
      const style = globalThis.document?.documentElement?.style;
      if (!style?.setProperty) return;
      style.setProperty("--safe-area-top", `${this.safeAreaTop}px`);
      style.setProperty(
        "--safe-area-bottom",
        `${this.appliedSafeAreaBottom}px`,
      );
    },
    setSafeArea(side, value) {
      const next = clampSafeArea(value);
      if (side === "bottom") this.safeAreaBottom = next;
      else this.safeAreaTop = next;
      this.applySafeArea();
      this.persist();
      return next;
    },
    setDefaultView(value) {
      this.defaultView = normalizeSettings({ defaultView: value }).defaultView;
      this.persist();
    },
    setAutoCollapse(value) {
      this.autoCollapse = value !== false;
      this.persist();
    },
    setAutoFollow(value) {
      this.autoFollow = value !== false;
      this.persist();
    },
    restoreDefaults() {
      this.setTheme(DEFAULT_SETTINGS.theme);
      this.setDefaultView(DEFAULT_SETTINGS.defaultView);
      this.setAutoCollapse(DEFAULT_SETTINGS.autoCollapse);
      this.setAutoFollow(DEFAULT_SETTINGS.autoFollow);
      this.setSafeArea("top", DEFAULT_SETTINGS.safeAreaTop);
      this.setSafeArea("bottom", DEFAULT_SETTINGS.safeAreaBottom);
      this.resetContentWidth();
    },
  },
});
