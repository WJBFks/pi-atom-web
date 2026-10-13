const key = (kind, sessionId) => `atom-panel:${location.pathname}:${sessionId}:${kind}`;
export function readPanelPreference(kind, sessionId) {
  if (!sessionId) return null;
  try { return JSON.parse(localStorage.getItem(key(kind, sessionId))); } catch { return null; }
}
export function writePanelPreference(kind, sessionId, value) {
  if (!sessionId) return;
  try { localStorage.setItem(key(kind, sessionId), JSON.stringify(value)); } catch {}
}
