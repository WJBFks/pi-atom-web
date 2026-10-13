# 侧边栏与工作区：接手说明

本文面向维护 pi-atom-web 的 agent，描述当前实现与修改入口。先阅读项目 `AGENTS.md`，布局约定查 `DETAILS.md` §6、§7、§24，服务接口查 `extensions/COMPATIBILITY-API.md`。本文不替代源码中的参数校验。

## 1. 架构与职责

保持无构建 Vue 3：浏览器普通 JS、Composition API、`h()`；扩展服务使用 TypeScript。不引入独立项目或会话管理系统。工作区绑定宿主 Pi 当前目录，Git 使用所属整个仓库。

| 文件 | 职责 |
| --- | --- |
| `web/components/workspace/panel-registry.js` | 内容模块登记、打开/关闭事件入口 |
| `SidePanelHost.js`、`side-panel.css` | 通用外壳、顶部标签、宽度、懒加载、开合与恢复 |
| `WorkspacePanel.js` | 文件管理器/Git/新标签页/独立文件协调，草稿、请求与失效刷新 |
| `FileTree.js` | 根节点、层级缩进、Git 状态、行菜单、新建入口 |
| `FileEditor.js` | 文件预览、文本编辑、行号、更多操作 |
| `GitPanel.js`、`DiffView.js`、`ConflictEditor.js` | Git 操作、差异与冲突编辑 |
| `panel-preferences.js` | 页面身份和布局偏好存取 |
| `web/stores/workspace.js` | 请求取消、服务身份、Git 状态、目标监听 |
| `web/api/workspace.js` | 带鉴权的 RPC 与独立 SSE 客户端 |
| `extensions/workspace.ts` | 服务协调与监听订阅 |
| `extensions/workspace-files.ts` | 根目录边界、文件版本、读写与操作 |
| `extensions/workspace-git.ts` | 原生 Git 状态、差异、写操作、冲突 |

组件路径均相对于 `web/components/workspace/`，除表格明确写出完整相对路径的项。

## 2. 通用外壳接入合约

`SIDE_PANEL_REGISTRY` 当前登记 `workspace`，项包含 `id`、`label`、`load()`、`stylesheet`。模块及 CSS 在打开时加载；外壳不承担文件或 Git 业务。新增内容应登记新模块，避免把专属逻辑塞进外壳。

通过 `openSidePanel(id, payload)` 发送 `atom-open-side-panel`；`closeSidePanel(id)` 发送关闭事件。外壳目前关闭事件收起整个侧栏，并非删除指定模块。空 payload 再打开时保留已有页面；路径 payload 可用于打开文件并定位。

内容收到 `token`、`sessionId`、`payload`、`active`、错误和关闭回调；支持多标签时发出：

```js
emit("tabs-change", {
  tabs: [{ id: "directory", label: "文件管理器" }],
  active: "directory",
});
```

内容暴露 `selectTab(id)`、`closeTab(id)`、`resume()`。工作区额外暴露 `newTab()`，供顶部加号调用。未实现标签合约的模块显示注册表中的单标签；未实现 `newTab()` 的模块目前不会响应加号，扩展该能力时应显式设计通用合约。

## 3. 标签与页面状态

- `directory`：文件管理器，含树与单文件快捷预览，只能打开一个。
- `git`：独立 Git 页面，只能打开一个，不能渲染在文件管理器分栏中。
- `new`：新标签页入口，当前也只保留一个；提供文件管理器与 Git。选择后复用目标标签并关闭入口页。
- `file:<path>`：独立文件标签；路径相对于选中的工作区根。

`directoryOpen`、`gitOpen`、`newTabOpen` 决定标签是否存在；`pane` 决定当前页面类型；`pinned` 保存独立文件路径，`activeDocument` 保存当前文件，`quickFile` 保存树右侧最后预览的文件。不要用残留 `activeDocument` 覆盖 `pane === "git"` 的渲染选择。

点树中的文件只替换快捷预览；“在标签中打开”图标将其提升为独立标签。关闭非活动页面标签不切换当前页面；关闭活动页面选择剩余页面，关闭全部标签收起侧栏。文件关闭另有未保存草稿确认逻辑，修改标签切换时应同时核对这一分支。

## 4. 持久化与生命周期

localStorage 键 `atom-panel:<location.pathname>:<sessionId>:host/workspace`：

| 范围 | 保存字段 |
| --- | --- |
| host | `ids`、`active`、`last` |
| workspace | `root`、`pane`、`directory`、`git`、`newTab`、`files`、`active`、`preview` |

宽度另存 `atom-side-panel-width`、`atom-workspace-tree-width`。不保存文件内容、完整 diff 或编辑草稿。凭证由连接层处理，不写入这些工作区偏好对象。

折叠保留已挂载内容、打开标签和内存草稿，但停监听与刷新；刷新按保存路径重新请求内容，失效文件跳过。草稿离开页面前提示，不能宣称刷新会恢复草稿。会话切换取消旧请求，清理工作区状态并重新配置服务。

Store 使用 `generation` 拒绝旧请求结果，`watchGeneration` 防止异步订阅在关闭后重新生效；AbortController 分别管理 RPC 与 SSE。新增异步逻辑必须遵循相同生命周期，不能让旧会话响应写入当前页面。

## 5. 布局与视觉约定

外壳是 `main` 直属子节点，覆盖右侧从顶到底；左侧工具栏和消息区域随侧栏宽度缩小。默认约 42%，桌面至少为左右各保留 320px；窄屏侧栏覆盖显示。开合 180ms，拖拽期间禁用宽度动画，减少动态效果设置关闭过渡。

ResizeObserver 读取左侧工具栏高度 H：侧栏顶部标签高 H/2，第二行操作栏高 H/2。主分隔线与左侧工具栏底线对齐。调宽条只使用 col-resize 光标，不加 hover 装饰；树/预览之间 6px 热区只画一条 1px 线。树最小 120px、预览至少保留 160px；窄屏改上下分布。

文件树与标签背景使用页面 `--bg`。编辑区（`.ws-code`）与冲突编辑框（`.ws-conflict textarea`）也用 `--bg`（用户 2026-09-30：“编辑页面好丑，用白色背景”：原先跟的是 `--panel`，浅色下就是一片淡蓝灰），行号列 `.ws-lines` 不设自有背景、随父级编辑区，只靠 `border-right` 那一条竖线分隔；工具栏按钮/输入框继续用 `--panel`，与白底编辑区形成对比。树每级 15px 行内缩进，不画引导线；hover/active 覆盖包括缩进在内的整行。Git 新增/未跟踪绿色、修改/重命名黄色、删除/冲突红色，字母和悬停说明补充颜色语义。忽略项优先用中性灰：浅色 `#999999`、深色 `#888888`。隐藏与忽略项默认显示，不提供过滤开关。

根节点只显示目录名，右侧为新建文件/目录 SVG。搜索位于顶部操作栏；当前目录与仓库根规范化相同时隐藏切换。行更多按钮无常驻占位：hover、焦点或菜单展开时隐藏 Git 标记、显示更多图标。

自动换行：不再由本模块自己实现 —— 开关、行号逐行对齐与代码块按钮的委托点击全部收在通用层 `web/line-wrap.js`（`web/main.js` 装一次 `installLineWrap()`），侧栏标题栏那颗换行图标（图片与二进制文件不显示，开启时上强调色）与转录里每个代码块头部的 `.code-wrap-toggle` 读写的是同一个 ref。状态存 localStorage 全局键 `atom-line-wrap`（默认关），并同步到 `<html class="atom-wrap">`，折行规则在 `web/style.css` 的 `html.atom-wrap …` 那组里。FileEditor 侧只剩两件事：`.ws-code` 上写 `data-start-line`（分页起点），以及把 `.ws-lines` 渲染成**空元素**交给通用层填；正文/模式/分页变了以后调一次 `refreshLineWrap()`（textarea 改 value 不产生 DOM 变动记录，MutationObserver 看不到）。

预览无“快捷预览”标题，文件标题只保留独立打开与更多图标；其余操作在菜单中。菜单容器不能被标题栏 overflow 裁切；标题栏层级 31。顶部操作栏禁用纵向滚动，文件树和代码区独立滚动。代码预览逐层 flex 填满剩余高度，不能恢复 `65vh` 上限；底部不显示工作目录路径栏。文本编辑器（`.ws-code`）同样必须顶满：`web/style.css` 里给输入卡写的**裸元素规则** `textarea{min-height:68px;max-height:250px}` 会泄漏到侧栏，把编辑区限到 250px（行高 19.8px → 正好 12.6 行，症状是“只渲染到第 12 行、下面整片空白”），所以 `.ws-code textarea` 必须显式写 `height:100%;min-height:0;max-height:none`，并把滚动交给 textarea 本身（`.ws-code` 为 `overflow:hidden` + 单行 `minmax(0,1fr)`，行号列 `.ws-lines` 靠 `onScroll` 同步 `scrollTop`）；不这么写就会同时出现双滚动条与一片空白。

## 6. 文件操作与安全边界

目录展开按需读取；搜索防抖 250ms，有截断提示。目录/文件行菜单提供重命名和删除，重命名页面弹窗只接受同父目录名称，拒绝空名称、`.`、`..` 和路径分隔符。该约束属于树菜单；其他入口与服务能力修改时应另核对源码，不据此假定整个服务禁止移动。

文件服务根只能是服务端认可的 `cwd`/`repo`，必须验证真实路径、符号链接和 Windows junction 边界；`.git` 内部禁止编辑。不要仅用字符串 startsWith 校验路径。

完整编辑上限 2 MiB，大文件只读分页，不能将截断内容保存。保存携带读取版本，版本冲突展示磁盘/草稿差异，用户选择重载或确认覆盖。二进制与图片有单独预览/下载流程；下载目前 64 MiB 上限。具体限制以文件服务常量与返回 `reason` 为准。

删除展示实际路径与影响范围并确认；草稿存在时不得静默重命名、删除或覆盖。文件引用与上传仍为项目 TODO，不借此功能顺手实现。

## 7. RPC、监听与 Git

POST `api/workspace`，JSON `{sessionId, op, ...params}`，Bearer 鉴权；GET `api/workspace/events?sessionId=...&watchId=...` 为独立 SSE。所有地址经 `apiPath()`，支持网关会话前缀。不要写死站点根地址，也不要将文件或 diff 塞进聊天快照。

文件操作包括 `info/list/search/read/save/create/rename/delete/download`，监听 `watch/unwatch`；Git 操作由 `git_` 前缀路由至 Git 服务。客户端非成功响应抛出带 `status`、`body` 的错误，界面显示服务错误，不隐藏认证、锁或并发修改失败。

监听目标为根节点、展开目录、独立打开文件及当前快捷预览，最多提交 64 个目标；SSE 只发失效通知。页面激活且可见时每 5 秒刷新 Git 状态、必要时恢复监听；折叠或页面隐藏时停止相关工作。失效刷新应保留草稿，只按变化重新读取所需内容。前台请求超过 250ms 才显示“处理中”，后台刷新不闪加载提示。

Git 使用原生命令参数数组、不拼 shell；双状态区分 index/worktree。写操作服务内串行，携带 revision 校验，遇到外部变动、锁或认证失败报告错误并刷新，不自动重试写操作。`check-ignore` 不支持 literal pathspec magic，该命令单独关闭 pathspec 环境开关、使用 NUL stdin；不要取消所有命令的 literal 保护。

Git 页面包含状态、历史、diff、暂存/取消暂存、提交、分支、远程及 stash；pull 默认仅快进，可选 merge/rebase，不自动 stash，不支持强制 push 或任意命令。冲突支持三栏结果编辑、显式标记解决及继续/中止；二进制阶段按原始字节处理，不能 UTF-8 解码后写回。

## 8. 常见问题与接手步骤

| 现象 | 优先检查 |
| --- | --- |
| `/reload` 后资源或 RPC 404 | 网关前缀、资源许可、服务实例交接；浏览器请求取消不应删除网关路由 |
| Git 切回文件管理器 | pane 渲染条件、标签 watcher 依赖、恢复逻辑与异步文件读取 |
| 菜单只露出边框 | 标题栏/祖先 overflow 与菜单层级 |
| 代码下方大空白 | flex 链、min-height:0、旧 max-height |
| 树右侧空列 | 更多按钮是否重新变为常驻 flex 占位 |
| 处理中闪烁 | 后台请求是否错误计入前台计数、`.git` 监听反馈循环 |

接手先定位对应组件和 DETAILS 小节，不整篇读取巨型文档。仅做授权范围内改动，保留其他 agent 的修改。按项目约定不写、不改、不运行测试，只执行 `node scripts/check.mjs`；语法通过不代表浏览器验收通过。目检由用户 `/reload` 后完成，特别检查窄屏、长路径、菜单、标签关闭、恢复、草稿与 Git 冲突。
