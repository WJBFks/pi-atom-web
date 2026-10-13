import { apiPath } from "./base.js";

export async function workspaceRequest(token, sessionId, op, params = {}, fetchImpl = fetch, signal) {
  const response = await fetchImpl(apiPath("api/workspace"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, op, ...params }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `工作区请求失败 (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function openWorkspaceEvents(token, sessionId, watchId, onEvent, signal, fetchImpl = fetch) {
  const params = new URLSearchParams({ sessionId: String(sessionId || ""), watchId: String(watchId || "") });
  const response = await fetchImpl(`${apiPath("api/workspace/events")}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal,
  });
  if (!response.ok || !response.body) { const error = new Error(`工作区监听失败 (${response.status})`); error.status = response.status; throw error; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = packet.split("\n");
      const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) { try { const value = JSON.parse(data); onEvent(value && typeof value === "object" ? { ...value, type: value.type || eventType } : { type: eventType, data: value }); } catch { /* 忽略无效事件 */ } }
    }
  }
}
