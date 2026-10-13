/**
 * 后端接口地址。
 *
 * 页面可能挂在站点根（直连 `http://127.0.0.1:<随机端口>/`），也可能挂在网关的会话前缀下
 * （`http://<ip>:30359/<会话短码>/`）。所以接口必须跟着**页面所在目录**走：
 * 写死 `/api/events` 在前缀模式下会打到站点根，网关那儿没有这条路由 → 整页连不上。
 * 同理 index.html 的资源引用、fonts.css 的 url() 与包内注入的 <link> 都必须相对当前页面。
 * 坑：importmap 的取值必须是 `./vendor/x.js` 这种带点的相对 URL，裸的 `vendor/x.js` 会被当裸标识符、整条映射被浏览器忽略（表现为白屏 + Failed to resolve module specifier）。
 */
export function apiPath(name, search = "") {
  // 优先用文档的 <base>（走网关时由服务端按 `x-forwarded-prefix` 注入）：它比
  // `location.pathname` 推出来的目录可靠 —— 地址缺结尾斜杠时，从 pathname 推会退到
  // 站点根（`/56da8` 的“目录”是 `/`），资源与接口会一起 404（用户 2026-09-30）。
  // `base.href` 本身已是解析好的绝对地址，拿它当基准后 fetch 仍是同源地址。
  const path =
    globalThis.document?.querySelector?.("base[href]")?.href ||
    globalThis.location?.pathname ||
    "/";
  const base = path.endsWith("/")
    ? path
    : `${path.slice(0, path.lastIndexOf("/") + 1)}`;
  return `${base}${name}${search}`;
}
