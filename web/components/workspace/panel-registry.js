export const SIDE_PANEL_REGISTRY = Object.freeze([
  Object.freeze({ id: "workspace", label: "工作区", stylesheet: "components/workspace/workspace.css", load: () => import("./WorkspacePanel.js") }),
]);

export function openSidePanel(id, payload = {}) {
  if (!SIDE_PANEL_REGISTRY.some((panel) => panel.id === id)) return false;
  window.dispatchEvent(new CustomEvent("atom-open-side-panel", { detail: { id, payload } }));
  return true;
}

export function closeSidePanel(id) {
  if (!SIDE_PANEL_REGISTRY.some((panel) => panel.id === id)) return false;
  window.dispatchEvent(new CustomEvent("atom-close-side-panel", { detail: { id } }));
  return true;
}
