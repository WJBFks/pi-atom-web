import { stripVTControlCharacters } from "node:util";
import { toToolJson } from "./tool-events.ts";

const OBSERVER = Symbol.for("pi-atom-web.entry-renderer-observer");

export function installEntryRendererObserver(Runner) {
  const prototype = Runner?.prototype;
  if (!prototype || typeof prototype.getEntryRenderer !== "function")
    return new Map();
  if (prototype[OBSERVER]) return prototype[OBSERVER].renderers;
  const original = prototype.getEntryRenderer;
  const state = { renderers: new Map(), listeners: new Set(), original };
  Object.defineProperty(prototype, OBSERVER, { value: state });
  prototype.getEntryRenderer = function (customType) {
    const renderer = original.call(this, customType);
    if (renderer) {
      state.renderers.set(customType, renderer);
      for (const listener of state.listeners) listener(customType);
    }
    return renderer;
  };
  return state.renderers;
}

export function onEntryRendererObserved(Runner, listener) {
  installEntryRendererObserver(Runner);
  const state = Runner?.prototype?.[OBSERVER];
  if (!state) return () => {};
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function read(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

/** Convert any extension-owned appendEntry value into the bounded Web protocol. */
function rendererText(renderer, entry, expanded, theme, width) {
  if (typeof renderer !== "function" || !theme) return undefined;
  try {
    const component = renderer(entry, { expanded }, theme);
    if (!component || typeof component.render !== "function") return undefined;
    const lines = component.render(width);
    if (!Array.isArray(lines)) return undefined;
    return stripVTControlCharacters(lines.join("\n")).trim().slice(0, 256 * 1024);
  } catch {
    return undefined;
  }
}

export function normalizeCustomEntry(entry, namespace, options = {}) {
  const id = String(read(entry, "id") ?? "unknown").slice(0, 512);
  const customType = String(read(entry, "customType") ?? "custom").slice(0, 4096) || "custom";
  const timestamp = read(entry, "timestamp");
  const collapsedText = rendererText(
    options.renderer,
    entry,
    false,
    options.theme,
    options.width || 100,
  );
  const expandedText = rendererText(
    options.renderer,
    entry,
    true,
    options.theme,
    options.width || 100,
  );
  return {
    id: `${namespace}:branch:${id}`,
    role: "customEntry",
    customType,
    data: toToolJson(read(entry, "data")),
    ...(collapsedText ? { collapsedText } : {}),
    ...(expandedText ? { expandedText } : {}),
    ...(typeof timestamp === "string" && timestamp.length <= 4096
      ? { timestamp }
      : {}),
  };
}
