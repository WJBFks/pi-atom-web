import { validateAction } from "../../shared/protocol.js";

export async function postAction(token, action, fetchImpl = fetch, signal) {
  validateAction(action);
  const response = await fetchImpl("/api/action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(action),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}
