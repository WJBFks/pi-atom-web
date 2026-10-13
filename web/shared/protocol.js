/**
 * 浏览器侧的协议入口转发层。
 *
 * 为什么要有这个文件：静态服务把仓库的 `web/` 挂在 URL 根上，所以 `web/api/x.js` 的浏览器
 * 地址是 `/api/x.js`（少了 `web/` 这一层）。模块说明符是相对**模块自身 URL**解析的，
 * 于是仓库里正确的 `../../shared/protocol.js` 到了浏览器会多退一层：
 *   · 直连：`/api/` + `../../shared/protocol.js` → `/shared/protocol.js`（多余的 `..` 被夹住，凑巧对）
 *   · 网关：`/ab561/api/` + 同一个说明符 → `/shared/protocol.js` —— **会话前缀整个丢了**，404
 * 改成 `../shared/protocol.js` 后两种模式都落在 `/<前缀>/shared/protocol.js` ✓。
 * 而这条说明符在 Node 里指向本文件（`web/shared/protocol.js`，仓库里并不存在真正的 shared 目录），
 * 所以这里做一层转发，让 `web/` 下的文件永远不需要退到 `web/` 之外。
 *
 * 浏览器实际上取不到本文件：`extensions/server.ts` 的 `configuredAssets()` 把顶层 assets 表里的
 * 显式挂载排在目录扫描之前，URL `/shared/protocol.js` 始终指向仓库根的 `shared/protocol.js`。
 * **那条挂载被删掉时本文件会被当成协议下发，并在浏览器里自我导入 —— 不许删。**
 */
export * from "../../shared/protocol.js";
