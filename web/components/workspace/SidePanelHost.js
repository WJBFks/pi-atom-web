import { defineAsyncComponent, defineComponent, h, onMounted, onUnmounted, ref, watch } from "vue";
import { icon } from "../../icons.js";
import { readPanelPreference, writePanelPreference } from "./panel-preferences.js";
import { SIDE_PANEL_REGISTRY } from "./panel-registry.js";
import { apiPath } from "../../api/base.js";

const loaders = new Map(SIDE_PANEL_REGISTRY.map((item) => [item.id, defineAsyncComponent(item.load)]));

export default defineComponent({
  name: "SidePanelHost",
  props: { token: String, sessionId: String, onError: Function },
  setup(props) {
    const activeIds = ref([]), activeId = ref(null), payloads = ref({}), width = ref(42);
    let host, link, dragCleanup, headerObserver;
    const alignHeader = () => { const main = host?.parentElement, toolbar = main?.querySelector(":scope > .toolbar"); if (!toolbar) return; const height = toolbar.getBoundingClientRect().height; if (height > 0) main.style.setProperty("--workspace-header-height", `${height}px`); };
    const contentStyles = new Map();
    const lastId = ref(null);
    let restoring = false;
    const persist = () => { if (!restoring) writePanelPreference("host", props.sessionId, { ids: activeIds.value, active: activeId.value, last: lastId.value }); };
    const contentRefs = new Map(), contentTabs = ref({});
    const updateTabs = (id, state) => { contentTabs.value[id] = state; if (activeId.value === id && !state.tabs.length) close(); };
    const applyWidth = () => { const available = host?.parentElement?.clientWidth || innerWidth; width.value = Math.max(320, Math.min(width.value, available - 320)); host?.parentElement?.style.setProperty("--workspace-width", `${width.value}px`); host?.parentElement?.parentElement?.style.setProperty("--side-panel-width", `${width.value}px`); };
    const open = ({ id, payload = {} }) => {
      if (!loaders.has(id)) return;
      const existed = activeIds.value.includes(id);
      if (!activeIds.value.includes(id)) activeIds.value = [...activeIds.value, id];
      if (!existed || Object.keys(payload).length) payloads.value[id] = payload;
      if (existed && !Object.keys(payload).length) contentRefs.get(id)?.resume?.();
      activeId.value = id;
      lastId.value = id;
      host?.parentElement?.classList.add("workspace-open");
      host?.parentElement?.parentElement?.classList.add("workspace-layout");
      applyWidth();
      if (!link) { link = document.createElement("link"); link.rel = "stylesheet"; link.href = apiPath("components/workspace/side-panel.css"); document.head.append(link); }
      const entry = SIDE_PANEL_REGISTRY.find(item => item.id === id);
      if (entry.stylesheet && !contentStyles.has(id)) { const style = document.createElement("link"); style.rel = "stylesheet"; style.href = apiPath(entry.stylesheet); document.head.append(style); contentStyles.set(id, style); }
      persist();
    };
    const close = () => {
      activeId.value = null;
      host?.parentElement?.classList.remove("workspace-open");
      host?.parentElement?.parentElement?.classList.remove("workspace-layout");
      persist();
    };
    const onOpen = (event) => { const detail = event.detail || {}; open({ ...detail, id: !Object.keys(detail.payload || {}).length && lastId.value ? lastId.value : detail.id }); };
    const restore = () => { const saved = readPanelPreference("host", props.sessionId); if (!saved || !Array.isArray(saved.ids)) return; restoring = true; close(); activeIds.value = []; for (const id of saved.ids.filter(id => loaders.has(id))) open({ id }); lastId.value = loaders.has(saved.last) ? saved.last : activeIds.value.at(-1); if (loaders.has(saved.active)) open({ id: saved.active }); else close(); restoring = false; };
    watch(() => props.sessionId, restore);
    const onClose = () => close();
    const startResize = (event) => {
      event.preventDefault();
      const move = (next) => {
        const rect = host.parentElement.getBoundingClientRect();
        const available = rect.width;
        const side = Math.min(Math.max(available - (next.clientX - rect.left), 320), Math.max(320, available - 320));
        width.value = side;
        applyWidth();
      };
      const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); document.body.classList.remove("is-resizing"); try { localStorage.setItem("atom-side-panel-width", String(Math.round(width.value))); } catch {} dragCleanup = null; };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true }); document.body.classList.add("is-resizing"); dragCleanup = stop;
    };
    onMounted(() => {
      window.addEventListener("atom-open-side-panel", onOpen);
      window.addEventListener("atom-close-side-panel", onClose);
      window.addEventListener("resize", applyWidth);
      try { const saved = Number(localStorage.getItem("atom-side-panel-width")); if (Number.isFinite(saved) && saved >= 320) width.value = saved; else width.value = Math.round(innerWidth * 0.42); } catch { width.value = Math.round(innerWidth * 0.42); }
      const initial = () => { if (host?.parentElement) { const rect = host.parentElement.getBoundingClientRect(); width.value = Math.max(320, Math.min(width.value, rect.width - 320)); applyWidth(); } };
      requestAnimationFrame(initial);
      const toolbar = host?.parentElement?.querySelector(":scope > .toolbar");
      if (toolbar && typeof ResizeObserver === "function") { headerObserver = new ResizeObserver(alignHeader); headerObserver.observe(toolbar); }
      alignHeader();
      restore();
    });
    onUnmounted(() => { headerObserver?.disconnect(); window.removeEventListener("resize", applyWidth); window.removeEventListener("atom-open-side-panel", onOpen); window.removeEventListener("atom-close-side-panel", onClose); dragCleanup?.(); link?.remove(); for (const style of contentStyles.values()) style.remove(); host?.parentElement?.classList.remove("workspace-open"); host?.parentElement?.parentElement?.classList.remove("workspace-layout"); });
    const keyboardResize = (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const rect = host.parentElement.getBoundingClientRect(); const delta = event.key === "ArrowLeft" ? 16 : -16; width.value = Math.max(320, Math.min(rect.width - 320, width.value + delta)); applyWidth(); }
      if (event.key === "Home") { event.preventDefault(); width.value = 320; applyWidth(); }
      if (event.key === "End") { event.preventDefault(); width.value = host.parentElement.clientWidth - 320; applyWidth(); }
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { try { localStorage.setItem("atom-side-panel-width", String(Math.round(width.value))); } catch {} }
    };
    return () => h("div", { role: "complementary", "aria-label": "工作侧栏", "aria-hidden": !activeId.value, inert: !activeId.value, class: ["side-panel-host", !activeId.value && "inactive"], style: { display: activeIds.value.length ? undefined : "none" }, ref: (el) => { host = el; } }, [
      h("div", { class: "side-panel-tabs" }, [
        ...activeIds.value.flatMap(id => (contentTabs.value[id]?.tabs || [{ id: id, label: SIDE_PANEL_REGISTRY.find(item => item.id === id)?.label || id }]).map(tab => h("div", { key: `${id}:${tab.id}`, class: ["side-panel-tab-item", activeId.value === id && (!contentTabs.value[id] || contentTabs.value[id].active === tab.id) && "active"] }, [
          h("button", { type: "button", class: "side-panel-tab", title: tab.label, onClick: () => { activeId.value = id; contentRefs.get(id)?.selectTab?.(tab.id); } }, tab.label),
          h("button", { type: "button", class: "side-panel-tab-remove", "aria-label": `关闭 ${tab.label}`, onClick: () => { const component = contentRefs.get(id); if (component?.closeTab) component.closeTab(tab.id); else { activeIds.value = activeIds.value.filter(item => item !== id); if (activeId.value === id) close(); } } }, "×"),
        ]))),
        h("button", { type: "button", class: "side-panel-add", title: "新标签页", "aria-label": "新标签页", onClick: () => contentRefs.get(activeId.value)?.newTab?.() }, icon("plus")),
        h("button", { type: "button", class: "side-panel-close icon-button", title: "收起侧栏", "aria-label": "收起侧栏", onClick: close }, icon("workspace")),
      ]),
      ...activeIds.value.map((id) => h("div", { class: ["side-panel-content", (activeId.value || lastId.value) !== id && "inactive"], key: id }, [h(loaders.get(id), { ref: component => { if (component) contentRefs.set(id, component); else contentRefs.delete(id); }, token: props.token, sessionId: props.sessionId, payload: payloads.value[id], active: activeId.value === id, onTabsChange: state => updateTabs(id, state), onClose: close, onError: props.onError })])),
      h("div", { class: "side-panel-divider", role: "separator", tabindex: 0, "aria-orientation": "vertical", "aria-label": "调整侧栏宽度", onPointerdown: startResize, onKeydown: keyboardResize }),
    ]);
  },
});
