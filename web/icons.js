import { h } from "vue";
const iconPaths = {
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/>',
  chat: '<path d="M4 5h16v12H8l-4 3Z"/><path d="M8 9h8M8 13h6"/>',
  trace: '<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>',
  session: '<path d="M3 6h6l2 2h10v11H3Z"/>',
  up: '<path d="M12 18V6M7 11l5-5 5 5"/>',
  down: '<path d="M12 6v12M7 13l5 5 5-5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  mode: '<path d="M8 5h8M6 9h12M8 13h8M10 17h4"/>',
  model:
    '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M19 9h4M1 15h4M19 15h4"/>',
  thinking:
    '<path d="M9 18h6M10 22h4"/><path d="M8.5 15.5A7 7 0 1 1 15.5 15.5L14 18h-4Z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  workspace: '<path d="M3 6h7l2 2h9v11H3Z"/>',
  conversation: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tokens:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  cache:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M17.9 16A7 7 0 0 1 6 18l-2-6"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5H5v11h3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 5v6h-6"/>',
  reset: '<path d="M4 13a8 8 0 1 0 2.4-5.7"/><path d="M4 7v6h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
export function icon(name) {
  return h("svg", {
    class: "ui-icon",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
    innerHTML: iconPaths[name] || "",
  });
}
