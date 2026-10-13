import { apiPath } from "../../../api/base.js";

const STYLE_ID = "package-style:@juicesharp/rpiv-ask-user-question";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  // 不能写死 `/packages/...`：走网关时页面挂在 `/<会话短码>/` 下，绝对地址会打到站点根拿不到样式。
  link.href = apiPath("packages/@juicesharp/rpiv-ask-user-question/style.css");
  document.head.append(link);
}

export { default } from "./AskUserForm.js";

export function clearRequestState(id) {
  try {
    sessionStorage.removeItem(`ask-user:${id}`);
  } catch {}
}

export function cleanupRequestState(requests) {
  const ids = new Set(requests.map(request => request.id));
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("ask-user:") && !ids.has(key.slice(9)))
        sessionStorage.removeItem(key);
  } catch {}
}
