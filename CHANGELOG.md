# 变更记录

## Unreleased — 开发中

### 新增

- **自动换行开关：文件视图 + 所有代码块共享一个全局状态**（用户 2026-10-01 先要求「文件编辑器增加一个按钮用于开启和关闭自动换行」，紧接着要求「为所有的代码块也增加这个按钮，共享开关状态」）。实现全部收在新文件 **`web/line-wrap.js`**（`web/main.js` 调一次 `installLineWrap()`）；原先的 `web/components/workspace/line-wrap.js` 删掉，`panel-preferences.js` 里为它加的 `readGlobalPreference`/`writeGlobalPreference` 一并回退。覆盖两类宿主：`.ws-code`（`textarea` + `.ws-lines`）与 `.code-block`（`pre.code-source` + `pre.code-lines`）。
  - **开关**：模块级 `wrapLines` ref + localStorage `atom-line-wrap`（**默认关**，不按会话 / 文件 / 页面路径分叉），并同时同步到 `<html class="atom-wrap">`。折行本体是 `style.css` 里 `html.atom-wrap …` 那组规则（`.ws-code textarea` 与 `.code-block .code-source` 都 `pre-wrap` + `overflow-wrap:anywhere`；后者额外 `flex:1 1 0;min-width:0` —— 代码块正文原本是 `flex:none` 的 `<pre>`，按 max-content 排，不给它吃掉剩余宽度就根本不折），所以**切换开关不重渲染任何组件**。
  - **所有代码块都有按钮**：`codeBlock()` 在 `.code-header` 里多输出一颗 `.code-wrap-toggle`（在复制按钮左边、同款样式：默认 `opacity:0`、块 hover 或键盘聚焦才出现，`[aria-pressed=true]` 时常驻 + 上强调色；图标跟 `icons.js` 的 `wrap` 同一套路径）。**代码块是字符串模板、各处用 `innerHTML` 注入，拿不到组件内的事件绑定**，所以点击靠 `installLineWrap()` 装的**文档级事件委托**，`aria-pressed` 也由它每次刷完行号后统一写（模板里写死初值会与全局状态不一致）。工具卡输入/输出、Markdown 输出、JSON 弹层、自定义 Entry、侧栏文件预览里的代码块一并生效；侧栏标题栏那颗按钮与它们读写的是同一个 ref。
  - **行号逐行对齐**（用户选定那一档）：`alignRowGutter()` 把行号列换成「一格一行」，每格 `height` 取**全局单例隐藏镜像** `.line-wrap-measure` 逐行量到的 `offsetHeight`（逐行放同一句纯文本，字体 / 行高 / 字距 / `tab-size` / 折行规则全从正文元素 `getComputedStyle` 照抄，宽度取 `clientWidth - 左右 padding`，textarea 的 `clientWidth` 已扣掉纵向滚动条）；先读齐所有高度再写入，格高没变不重写。**没有把 `codeBlock()` 改成逐行结构**（整个转录共用，§17），行号格是在它的 innerHTML 产物上就地改的；关掉换行则还原成整块文本。宿主把行号列渲染成**空元素**（内容全交给本模块，否则跟 Vue 的 patch 打架），起始行号走 `.ws-code` 的 `data-start-line`、代码块从自己那份行号文本读第一个数。流式输出 / 折叠块展开 / 切工具卡靠 MutationObserver（只看 `childList`）催一次；textarea 改 `value` 不产生 DOM 记录，所以 FileEditor 显式调 `refreshLineWrap()`；宽度变化由每宿主一个 `ResizeObserver` 弄脏签名后重算（拖侧栏分隔线不会触发 `window.resize`）。
  - 连带：`focusLine` 跳转在换行态不再用 `行号 × 行高`（会跳错行），改成累加行号列前 N 格高度；图标 `web/icons.js` 新增 `wrap`（整行 + 一条向右再折回左边、箭头朝左），`codeBlock()` 与侧栏标题栏共用同一套路径。
  - 实测（临时 Chromium 探针 + 真 `codeBlock()` + 真 FileEditor，960px 窗口，用完已删；指标 = 每格高度与「同宽同字体的参照 `pre`」逐行比对的差值合计）：开换行后代码块格高 `[79, 20, 178]`、编辑区格高 `[59, 20, 20, 139, 20]`，两边差值合计都是 **0**；流式追加一行 2000 字符后代码块自动重算成 `[79, 20, 178, 337]`；宿主拖窄到 560px 后重算成代码块 `[119, 20, 297, 594]`、编辑区 `[99, 20, 20, 238, 20]`，四种场景差值全部为 0；点代码块那颗按钮时 `<html>` 的 `atom-wrap`、编辑区按钮的 `aria-pressed` 与 `localStorage`（`atom-line-wrap=1`）一同翻转，用编辑区那颗关回则两边行号列都还原成整块文本、`white-space` 回到 `pre`；无页面报错。`node scripts/check.mjs` 通过（101 源文件 / 5 样式表）。
  - 代价与边界：开启时每个宿主多一份隐藏镜像 + 逐格 DOM（分页上限 2000 行），输入 / 宽度变化时重测；关闭态几乎零开销。纯文本镜像能代表高亮正文的前提是等宽字体下斜体不换字符宽（本项目 hljs 只有 `.hljs-comment`/`.hljs-quote` 是 italic）——**以后若给高亮加 `font-weight:bold` 且字体没有同宽粗体，测量会偏**。Diff 视图（`.ws-diff-*`）不在此列，仍旧横向滚动。本轮按约定不写不改不跑仓库测试；点名风险：转录里每个代码块的 header 多了一颗 button，若有用例按索引点 `.code-header button` 或断言 header 里只有一颗按钮会红 —— 现有用例都是按 `.code-copy` 类名取的（`test/browser/web.spec.js:3203`），没发现会红的。

- **Web 服务会自己回来了：重启 pi 后自动恢复（`autoServe`）+ 网关的「会话不在线」等待页**（用户 2026-09-30：「有的时候，我的 Web UI 可能是在远程其他机器上打开的，我做不到在对应 TUI 执行 `/web`」；一轮选定：只恢复显式开过的会话、局域网也照原样恢复、重试 + 3 分钟超时）。
  - 之前只有 `/reload` 有进程内交接（`Symbol.for("pi-atom-web.reload-handoff")`）能保住地址：pi 进程真的退出（关 TUI、崩溃、重启机器、`pi --continue` 重开）后 `session_shutdown` 会关掉服务并注销网关路由，**下次启动必须有人到 TUI 里再敲一次 `/web`** —— 而远程浏览器那侧的人做不到，只能看着一排 404（`fonts.css` / `style.css` / `main.js` / `marked.js` / `purify.js` / `highlight.js` 全红：`web/index.html` 用的是**相对地址**，文档所在的 `/<短码>/` 前缀一失效，六个资源全死）。
  - `extensions/gateway-client.ts`：`config.json` 多一个 `autoServe`（默认开），并新增登记表 `~/.pi/atom/web/sessions.json` —— `{ [sessionId]: { mode: "loopback"|"lan", at } }`（`0600`，读时丢掉超 90 天的条目），导出 `autoServeMode()` / `rememberWebSession()` / `forgetWebSession()`。`/web` 与 `/web-wlan` 启动成功后登记，`stopWebServer()` 抹掉 —— **用户主动关掉就是一个意图，下次不自动开**。
  - `extensions/index.ts`：新增 `autoServeWeb(ctx)`，`session_start` 里**只在没有 `/reload` 交接时**走它（两条恢复路径互斥，不会重复起服务）：按表里的 mode 重新 `startWebServer()`（局域网用新常量 `LAN_HOST`）+ `attachWebGateway()` + `attachNotifications()` 并在 TUI 通知地址。`/web` 多一个子命令 `/web auto on | off | status`（总开关，不进设置页也能一键全局禁掉）。
  - `extensions/gateway.mjs`：路由表里没有这个短码时，**文档请求**（`GET` 且 `Accept` 含 `text/html`）返回 `waitingPage()` —— 503 + `Retry-After: 3`，用 `<meta http-equiv="refresh" content="3;url=…?__wait=<起始毫秒>">` 自动重试（**页面里零脚本**：这页 CSP 只放 `default-src 'none'; style-src 'unsafe-inline'`），超过 `WAIT_TIMEOUT_MS`（180s）就不再刷新、只给结论与一个「再试一次」链接（否则会话真关了就是永远转圈）；API / SSE / 静态资源仍旧 404 JSON（不然前端会把 HTML 当成快照或事件流去解）。短码取自 `url.pathname`（仍是百分号编码形式）且写回前一律过 `escapeHtml()`。另外 `/<短码>` 缺结尾斜杠的那个 302 现在**保留查询串**（原来只跳 `/${id}/`，`?…` 会被丢掉）。
  - **协议**：`webConfig` 新增强制布尔字段 `autoServe`，`configure_web` 新增可选 `autoServe`（`shared/protocol.ts` 与 `shared/protocol.js` **两份同时改**，并用 `validateServerEvent` / `validateAction` 实测：缺 `autoServe` 被拒、非布尔被拒、四个字段全空的 `configure_web` 仍按「缺少字段」拒）。设置页「会话 → Web 服务」在「固定凭证」下面多一行「自动恢复」（只写配置、不动服务，所以不需要接新凭证也不跳转）。
  - 前提与限制（已写进 `DETAILS.md` §3）：自动恢复要让收藏的地址真能用，**得开着固定凭证**（本机 `fixedToken` 已开）—— 否则进程重启后凭证重新随机，页面会拿旧 token 吃 401；`/web-wlan` 会照原样恢复成 `0.0.0.0` 监听，唯一凭据仍只剩 URL 片段里的凭证，全局禁止请用 `/web auto off`。**新建会话（`/session`）短码与凭证都会变**，这一步救不了，仍需拿一次新地址。
  - **`extensions/server.ts`（补上上一轮没批的 `<base>`）**：新增导出 `forwardedPrefix(value)` 把网关的 `x-forwarded-prefix` 收成 `/<短码>`（只认 `^/[0-9a-z][0-9a-z-]{2,15}$`，**且只有 `connection.proxy` 存在时才读这个头**，直连模式行为一点不变），并在唯一的 `text/html` 响应上把 `<head>` 换成 `<head><base href="/<短码>/">`。三个必须记住的点：① **不能动 importmap 的字节** —— CSP `script-src` 里那个 `'sha256-…'` 是启动时 `importMapHash()` 从磁盘原文算的，改一个字就是 importmap 被拦 + `Failed to resolve module specifier "vue"` 白屏（`<base>` 只改基准、不改元素内容，实测注入前后 importmap 字节一致、哈希仍对得上）；② CSP 的 **`base-uri` 从 `'none'` 改成 `'self'`**，否则浏览器直接忽略 `<base>`（放开到 `'self'` 仍要求同源）；③ `web/api/base.js` 的 `apiPath()` 改成**优先读 `base.href`**（没注到才退回 `location.pathname` 推目录），因为地址缺斜杠时 `location.pathname` 推出来的是站点根，接口会与资源一起 404；运行期注入的 `<link>`/`<script>`（xterm、包样式、侧栏样式）本来就走 `apiPath()`，一并受益。`web/api/event-stream.js` 的 `consumeToken()` **故意不改**：它的 token 存储键用 `location.pathname`，跟的是浏览器地址而不是基准。
  - 文档：`DETAILS.md` §2（`webConfig` / `configure_web` 字段）、§3（等待页两条响应、`autoServe` 全链路、`<base>` 注入与 `base-uri` 改动）、`extensions/COMPATIBILITY-API.md`、`README.md`。本轮按约定不写也不跑测试：`node scripts/check.mjs` 通过；网关侧用临时进程实测了等待页 / 超时分支 / HTML 转义 / 302 保留查询串（用完即清）；服务端用 `startServer({ connection: { proxy: … } })` 直接实测：带合法 `x-forwarded-prefix` 时响应里出现 `<base href="/56da8/">` 且 CSP 是 `base-uri 'self'`，伪造 `/../evil` 、缺该头、非网关模式都不注入。

- 新增侧边栏与工作区接手技术文档 `docs/sidebar-workspace.md`，覆盖模块合约、标签与恢复、布局、文件/Git 接口及排障细节。

- 侧栏顶部新增新标签页入口，文件管理器与 Git 各自使用唯一标签；选择入口自动复用页面并关闭新标签页，刷新恢复标签状态。

- **通用工作区侧栏与首批文件/Git视图**：新增懒加载 `SidePanelHost` 与 `SIDE_PANEL_REGISTRY`，按 `id/label/load/stylesheet` 登记侧栏内容，并通过 `openSidePanel(id, payload)` / `closeSidePanel(id)` 控制；当前登记工作区容器，内部由文件树、编辑器、Git、差异和冲突组件协作。独立 `/api/workspace` Bearer RPC 提供文件读写、监听及 Git 状态/差异/历史/写操作。文件编辑上限 2 MiB，下载上限 64 MiB；Git 写操作使用 revision 并发校验和显式危险操作确认。草稿保存在页面内存，侧栏宽度保存在 localStorage。侧栏布局与内容样式分离，后续内容可复用宿主。文件及 Diff 支持标签切换，Git 状态刷新不读取完整 diff；二进制冲突按原始字节解决。终端浏览器尚未实现。

### 修复

- **文件编辑器只渲染到第 12 行、下面整片空白**（用户 2026-09-30 图三圈出那片空白）。原因：`web/style.css` 里给输入卡写的是一条**裸元素规则** `textarea{…;min-height:68px;max-height:250px}`，它会泄露到侧栏的编辑器；`.ws-code textarea` 当时只声明了 `border/padding/font` 等，**没声明 `max-height` 与 `height`**，于是编辑区被限在 250px —— 按 `.ws-code` 的 `12px/1.65` 行高恰好 **12.6 行**（与截图里「渲染到第 12 行」完全对得上），而行号列 `.ws-lines` 按整份正文渲染，所以就出现「数字始终往下列、正文到 12 行就没」的空白（这一条与本次改成白底无关，白底只是把这片空白看得更清楚了）。修在 `web/components/workspace/workspace.css`：`.ws-code textarea` 补 `height:100%;min-height:0;max-height:none`，`.ws-code` 改成 `grid-template-rows:minmax(0,1fr)` + `overflow:hidden`（滚动交给 textarea本身，行号列继续靠 `onScroll` 同步 `scrollTop`；不留 `overflow:auto` 会同时出现双滚动条）；`.ws-conflict textarea` 一并补 `max-height:none`（它靠 `min-height:200px` 本来没那么严重，但手动拉高会被卡在 250px）。`docs/sidebar-workspace.md` 已记下这条约束与症状。待选：把 `web/style.css` 里那条裸 `textarea{…}` 收窄到 `#composer textarea`（根因侧的修法，但会动到输入卡样式，本轮没碰）。

- 连接凭证增加按页面路径隔离的 localStorage 恢复，sessionStorage 丢失后刷新可恢复连接；URL 新凭证优先并更新缓存。

- 移除工作区顶部操作栏多余的纵向滚动条，保留内容区域独立滚动。

- 修正独立文件标签的更多操作菜单被标题栏滚动容器裁切，菜单完整覆盖代码区显示。

- 删除工作区底部路径栏，代码预览填满剩余高度，取消固定视口高度上限导致的底部空白。

- 移除快捷预览标题行，独立打开改用 SVG 图标；文件操作收进更多菜单，保留保存禁用及分页条件。

- 文件树搜索框移至顶部操作栏，新建文件/目录改为根节点右侧图标；当前目录与仓库根目录相同时隐藏目录切换框。

- 取消文件树更多按钮的常驻占位，hover 时隐藏 Git 标记并在同一右侧区域显示更多图标。

- Git 标签独立渲染页面，避免活动文件残留或刷新恢复将其切回文件管理器；关闭非活动标签不再切换当前页面。

- 更多操作与新标签页按钮改用居中 SVG 图标，并增加按钮 hover 底色。

- 文件树操作改为 hover 显示「…」菜单，文件和目录均可重命名、删除；取消常驻目录操作区。重命名使用页面弹窗并限定当前父目录，不支持通过输入路径移动。

- 文件树忽略项改用更浅的中性灰，取消原灰色中的蓝色倾向。

- 文件树 hover 与选中背景覆盖左侧层级缩进区域，保持文字、图标原有位置。

- 目录树预留滚动条空间，并固定目录操作区布局；操作区显示/隐藏不再推动下方文件条目，长路径不撑高操作区。

- 文件树根节点移除「根目录」前缀，删除隐藏/忽略过滤开关，默认显示全部条目；Git 忽略项统一显示为灰色。

- 目录树保留层级缩进、移除引导线；增加整行 hover，选中效果改为柔和底色与低对比内边框，覆盖目录操作按钮并保持 Git 状态颜色。

- 文件树增加可折叠根目录、子级缩进及层级引导线；Git 状态改为绿色新增、黄色修改、红色删除/冲突，配合状态字母与中文悬停说明，目录汇总子级变更。

- 右上角侧栏按钮固定为 32×32px 并垂直居中，16px 图标四周各留 8px，修正按钮随标签栏高度拉伸造成的间距不一致。

- **侧栏开合与恢复**：展开时将侧栏按钮移到右上角替代收起 `×`，增加 180ms 过渡并尊重减少动态效果设置。折叠保留页面，刷新按会话恢复开合、文件标签、当前页面和快捷预览；仅保存布局与文件路径，不保存内容、凭证或草稿。

- 两处宽度分隔条取消 hover 高亮，仅保留调宽光标；目录树分隔条改为单条 1px 线，拖动热区保持不变。

- 侧栏顶部标签栏与目录树背景统一使用页面背景 `--bg`，与左侧对话区域一致，支持明暗主题。

- **侧栏完整布局与标题分隔线对齐**：侧栏铺满主区域右侧，顶部标签与下一行操作栏各占左侧工具栏实际高度的一半，左右主分隔线对齐。目录树与快捷预览之间增加可拖拽、可键盘操作的 6px 分隔条，布局宽度单独记忆。

- **网关请求取消后会话连续 404**：浏览器取消请求、关闭文件监听或上游暂时连接失败不再删除会话路由；旧请求无法误删 `/reload` 后的新注册。路由租约仅由 Pi 心跳续期，显式注销或心跳过期仍正常移除。

- **侧栏标签交互样式**：hover 底色覆盖标题与关闭按钮，选中标签使用强调色、加粗文字和独立的 2px 底线，底线不会被按钮 hover 背景覆盖。

- **侧栏标签与快捷预览分层**：移除目录右侧的文件标签栏，右侧仅展示最后点击的文件；增加「在标签中打开」，在顶部独立打开文件。顶部目录和文件标签均可关闭，独立文件占满侧栏，关闭最后一个标签收起侧栏。

- **打开侧栏后内容列宽度失效**：输入框恢复使用共享 `--content-width` 上限，并与正文在扣除侧栏、滚动条后的区域居中；桌面内容列把手恢复显示，侧栏调宽时重新计算把手位置。

- **工作面板“处理中”反复闪烁**：后台失效刷新不再触发前台加载提示；用户操作超过 250ms 才显示提示，并按并发请求数收尾。文件监听忽略 `.git` 内部变化，Git 状态查询关闭可选索引刷新，避免状态查询诱发重复刷新。

- **文件树忽略规则查询返回 500**：`git check-ignore` 不支持 `literal` pathspec magic；仅为该命令关闭 pathspec 环境开关，继续通过 NUL 分隔的 stdin 传递实际路径。其他 Git 路径操作保留 literal 保护。

- **排队的多条输入现在各自拿到自己的「已完成（时长）」**（用户 2026-09-25：「排队状态的多条消息输入，后续的排队进入的消息不会被认为是单独的任务……只有最后一条消息有 `processing-status is-done turn-status`，并且时间也是从第一条开始算到最后一条结束的」）：整轮起点原先是一个全局变量 `processingStartedAt`，靠 `||=` 起表、`agent_settled` 时清空。但**轮与轮在事件上是重叠的** —— pi 在 `agent_end` 之后立即摘下排队里的下一条，上一轮的 `agent_settled` 可能晚于下一轮的 `message_start(user)` 才到；于是中间那几轮整轮没有状态行，最后一条却拿到第一条的起点（本会话实测：只跑了 18 分钟的一轮被结算成 26 分钟，`durationMs = 1582703`）。
  - `extensions/index.ts` 新增 `turnClocks` / `beginTurnClock()` / `settleTurnClock()` / `turnClockKey()`：`message_start(role=user)` 每收到一条**非引导**用户消息就压一个 `{ startedAt, fromIndex }`，`agent_settled` 弹队首结算。**引导不起新表** → 仍然与它前面那一轮合算（用户口径：只有引导与前面计在一起）。
  - **起表只认 `message_start`，与 `agent_start` 谁先到都无所谓**：不依赖宿主事件顺序（两种可能的送达顺序都验证过）。
  - 徽标 key 在**本段分支** `[fromIndex, 下一轮 fromIndex)` 内找最后一条 assistant，所以 settle 迟到也不会挂到下一轮的消息上；段内没输出就丢弃该槽（命令类消息自愈），全部对不上才退回旧的「整条分支尾部」算法。`processingStartedAt` 改为**队首镜像**，**协议与前端未动**。
- **「其他」条目不再把会话切开**（用户 2026-09-25 圈出三张 `web-search-results · [JSON OBJECT]` 卡片问「这应该是个工具调用吧，为什么他把会话切开了」）。Pi 的 `custom` Entry 是扩展用 `appendEntry` 写进 branch 的**旁路展示数据**（实测一次 `web_search` 落一条 19.6 KB，而喂给模型的 toolResult 只有 2.5 KB —— 一份给人看、一份给模型看，它**不进模型上下文**）。它原先走 `groupMessages()` 的 else 分支 → `flush()`，**每条都变成轮次边界**，三次搜索就把一轮切成四段。
  - 判据是「有没有夹在本轮过程之间」（用户补口径：「`wj-scheduler-status` 这些心跳通常不在对话过程中，它们还是一个一个平铺」）：新增 `otherSitsInTurn(list, index)` —— 向前、向后各跳过连续的「其他」，**两端都是过程消息**才算本轮过程，才归进当前组（它不是 `isSoloEntry`；但点线得单独补 —— 「其他」条目没有 `.body` 包裹，`.body>*` 那组规则不命中，已按压缩块/引导块同一套几何补 `.turn-stage>.disclosure-body>.custom-entry-block` 四条，用户 2026-09-25：“左边的线和圆点缺了”）；孤立的一条继续逐条平铺、不计入任何轮次标题。`customEntry` 因此**不进** `PROCESS_ROLES`（那个集合保持三项），`groupMessages()` 与 `trailingProcessRun()` 共用同一判据，避免同一条条目在历史区与 live 区之间跳。
  - **页面统称「其他」**（用户：「它们都叫 custom 条目吧，那就统一叫做 `其他`」）：轮次标题与中间过程组标题新增计数分段**「其他`n`」**，「其他」固定垫底（排在压缩之后，取代原先的压缩垫底）；**卡片标题保留各家的 `customType` 原名，不给任何一家做专属视图，也不按插件名隐藏**（同日选定「全部保留」；实测本会话三家：`web-search-results` / `plannotator` / `wj-scheduler-status`）。
  - 纯前端改动：`web/components/conversation/turnGroups.js` 一个文件（`isOtherEntry()` + `otherSitsInTurn()` + `turnCounts().others` + `TURN_COUNT_LABELS`）；文档同步 §0 术语表新增「其他」行、§5 统称、§9 归组规则与 README。

### 变更

- **工作区文件编辑区改成白底**（用户 2026-09-30：“编辑页面好丑，用白色背景”）。`web/components/workspace/workspace.css`：`.ws-code`（行号列 + 正文那一整块）与 `.ws-conflict textarea`（冲突解决三个框）的 `background` 从 `var(--panel)`（浅色 `#f2f5f8`、深色 `#242424`）改成 `var(--bg)`（浅色 `#fff`、深色 `#1a1a1a`）—— 用主题变量而不是写死 `#fff`，深色主题不会变白屏。行号列 `.ws-lines` 本来就没自有背景（随父级，因此仍旧不透明），只靠 `border-right` 那一条竖线与正文分开；textarea 是 `background: transparent`，自动跟着变白。工具栏按钮与输入框仍用 `--panel`（在 `.workspace-panel button, select, input` 里），跟白底编辑区拉开对比；只读的 Git 日志 `.ws-log` 本次没动（仍旧 `--panel`，要一并改说一声）。`docs/sidebar-workspace.md` 相应那行已同步。

- **Prompt 队列不再默认展开，折叠态改成「一条消息一个长条」，行右侧直接带「引导」与「删除」**（用户 2026-09-29；一轮选定：按钮只加在折叠态长条右侧、每条一个长条、「引导」用文字 + 「删除」用图标、不弹面板但保留闪烁）。
  - `web/components/composer/ActivityBar.js`：队列从「一个 `消息队列 N` tab」拆成 `strip`（折叠态的每条长条）+ `panelOnly`（只在展开态大框顶部出现的队列面板 tab）。长条顺序：**引导（steer）整组在前、排队（followUp）在其后、同组内后到的在下面**（`QUEUE_STRIP_STEER_PRIORITY` 620 / `QUEUE_STRIP_FOLLOW_PRIORITY` 610，均在扩展请求 1000 之下），只平铺最靠前的 `QUEUE_STRIP_LIMIT` 5 条，剩下的收进一条「还有 N 条」（590）。长条标题就是那条消息的正文（新增 `plain` 标记 → 渲染成纯文本节点，不过 `renderInlineMarkdown`：用户输入里的 `**`/反引号不再变成样式），正文前最多两张 18px 缩略图（`imageUrl`），行右侧依次是类型切换文字按钮与「删除」图标按钮 —— 两个按钮是 `role=tab` 按钮的**兄弟节点**（不能嵌套交互元素），所以多一层 `.activity-tab.is-strip`。
  - 同日追加（用户 2026-09-30 看图指出）：长条**最左侧的图标按类型区分**（引导 = `send`、排队 = `mode`）；图标之后新增**当前类型徽片** `.activity-tab-kind`（写「引导」/「排队」，引导那枚用 `--accent` 描边+文字色、排队保持中性；不跟 tone 走，队列长条的 tone 是同一个蓝色分不开两类）；右侧那个文字按钮从「引导 / 排队」改成**目标类型**的「改为引导 / 改为排队」（徽片写「排队」的那条按钮就是「改为引导」，反之亦然），`title` 与 `aria-label` 同步。
  - **长条只是入口，面板只有一份**：`aria-controls` 与点击目标都指向 `PROMPT_QUEUE_PANEL_ID`，`expanded` 永远存面板 tab 的 id（某条消息被消费、长条消失时不会把开着的面板带走）；`rowTabs(inPanel)` 按行过滤（折叠行滤掉 `panelOnly`、展开行滤掉 `strip`，键盘导航也按当前行列表走），隐藏宿主同理只挂一份队列面板（否则每条长条各挂一份）。队列 watcher **不再自动展开**，只算 `queueFlash`；`focusTab` 在目标 tab 不在当前行时（面板 tab 折叠后就不在行里）退回聚焦行内第一个可见 tab。样式：折叠态的 tab 按钮从 `width:100%` 改成 `flex:1 1 auto;min-width:0`（给右侧按钮留位），新增 `.activity-tab-images` / `.activity-tab-image` / `.activity-tab-action`（高 18px、靠父级 `align-items:center` 居中、hover 用 tone 描边、disabled 降透）。
  - `web/stores/prompt-queue-actions.js`（新增）：把 `queue_update_item` / `queue_remove` 的提交（带 `revision`、单一 `changing` 门禁、报错上浮）从 `PromptQueuePanel` 抽出成 `usePromptQueueActions(token, onError)`，折叠态长条与面板共用。面板里原有的「转为引导 / 转为排队」**保留不动**（用户只说了「加在长条」；它也是超出 5 条时唯一的转换入口），本次面板只改了提交走 store。
  - 文档：`DETAILS.md` §20、`docs/activity-components.md`（tab 字段新增 `plain`/`strip`/`panelOnly`/`queueItem`、优先级表改五行、展开与键盘小节）、`README.md`；`extensions/COMPATIBILITY-API.md` 未动（本次只改 Web 侧展示，协议与队列 API 未变）。

- **活动组件折叠态从「一排短 tab 横向」改为「长条纵向堆叠，高优先级在上方」**（用户 2026-09-29，于一轮选定：与大框同宽、无缝贴合共享 1px 分隔线、行高保持 26px）。`web/style.css`：`.activity-tabs` 基底改为 `flex-direction:column;align-items:stretch;overflow:visible`（横向与 `overflow-x:auto` 收回 `.activity-tabs-in-panel`，展开态那一行不变），折叠态的 tab 按钮 `width:100%;max-width:none`、条目 `flex:0 0 auto`（避开 `flex-basis:auto` 在纵向时按高度解析）；相邻两行由非末项 `border-bottom:0` 共用下一行的上边框（两行各画一条就是 2px）；圆角只给最上一行 —— `:last-child` 先收掉右上圆角、`:first-child` 再把上方两角一起补上（两条特异度相同、靠源码顺序决胜，于是单 tab 时两角都圆），最下一行仍直角贴输入卡。**排序与 DOM 顺序未动**：`sortActivityTabs()` 本来就是 `priority` 降序，纵向堆叠后自然就是高优先级在最上方。`ActivityBar.js` 只改注释里的方位措辞，键盘额外接受 `ArrowUp` / `ArrowDown`（与左右同义，因折叠态已变成纵向）。附带：折叠态行容器的 `overflow` 改为 visible，共用关键帧 `activity-tabs-in` 里的 `max-height:34px` 在折叠态不再裁切，只当淡入用（展开态那一行仍靠 `overflow-x:auto` 保留原来的滑出效果）。`DETAILS.md` §20、`docs/activity-components.md`。

- **`ask_user_question` 在会话里的卡片标题改为「提问」，且不再折进中间过程组**（用户 2026-09-26）。**package 专属信息一律留在适配目录**（用户明确要求「特定内容仅写在 ask_user_question 扩展的适配目录下」）：新增 `web/packages/@juicesharp/rpiv-ask-user-question/tool-profile.js` 导出纯数据 `{ tool: "ask_user_question", label: "提问", solo: true }`，由新增的 `web/packages/tool-profiles.js` 静态登记；通用侧只加钩子 —— `ToolCallBlock.js` 的 `toolLabel()` 优先取档案的 `label`，`turnGroups.js` 加块级 `isSoloToolBlock()`（该 toolCall 块单独平铺，同一条消息里的思考块照旧归组）与 `isSoloToolResult()`（结果条一并平铺；它已被卡片按 `toolCallId` 合并、渲染成 `null`，留在组里会开出一个只带「中间过程」兜底标题的空组）。**计数不变**：轮次标题用整段的 `turnCounts(intermediate)`，提问仍算进「工具调用`n`」，只有中间过程组的标题不含它。样式补一处：平铺后该卡成了 `.turn-group>.disclosure-body` 的直接子代，会被「平铺正文发中性灰」那条命中（在组里时不会），灰字规则加 `:not(:has(.disclosure-block))` —— 带折叠卡片的平铺条目一律不发灰（`solo` 卡没有自有 class，为它往 `MessageItem` 塞类名等于把 package 信息写回通用侧）。`DETAILS.md` §9 / §21 / §22、`README.md`、`extensions/COMPATIBILITY-API.md`。
  - 摘要（折叠态 `.disclosure-preview`）也走档案：新增 `summary(args)` 钩子（`toolProfileSummary(name, args)` 返回空串就退回原来的「工具输出 / 报错信息」，档案侧抛异常一律吞掉），提问卡显示**第一题的 `header`**，多题是「`header` 等 N 题」（N 用包内 `sanitizeQuestions()` 的题数，跟表单 tab 数一致），缺 `header` 退回题干压平后前 16 字 + `…`，**答完也照旧显示 `header`**（用户 2026-09-26 一轮选定这三条）。
  - 提问的**专属图标 `ask-question`**：定义在包目录的 `icon.js`（纯数据、不 `import` 任何东西 —— 图标经 `tool-profiles.js` 喂给 `icons.js` 的登记循环，而那条链不能拖进依赖 vue 的模块）。外框与 `chat` 逐字相同、内部换成 `help` 那套「弧 + 竖段 + 点」的 0.8 倍；不写 `stroke`/`fill`，描边由 `.ui-icon` 基座给，所以自动跟随工具卡状态色。通用侧只加入口：`packageIconEntries()` + `icons.js` 里的登记循环（**与内置同名不覆盖**）、`toolIcon()` 优先取档案图标名；活动栏 `PACKAGE_ACTIVITY_LOOK` 的提问 tab 从 `help` 换成它（`help` 从此只留给「关于」页与通用请求）。

### 新增

- **输入卡左下角换成加号，点开成「添加」菜单**（用户 2026-09-25：「把左下角这个插入图片的图标改为一个加号，点击后展开这样的」，一轮问完选定：四项 / 不要分组小标题 / 展开时旋转成 ×）。新组件 `web/components/composer/AttachMenu.js`，`icons.js` 新增 `plus`；菜单四项 = **添加图片 / 斜杠命令 / 附加技能 / 压缩上下文**（图标复用 `image` / `terminal` / `spark` / `box`）。后三项只把命令写进草稿并聚焦（`/`、`/skill:`、`/compact `），**不替用户按下发送**；`/compact ` 末尾的空格是故意的，让 `^\/([^\s]*)$` 匹配不上、命令菜单不会跟着弹。展开时加号由 CSS 旋转 45° 变 ×（挂在 `aria-expanded` 上）；`outside()` 同时排除 `.attach-menu` 与 `#attach-button`（`pointerdown` 比 `click` 先到，不排掉按钮就永远关不上）；菜单 `left` 等于 `#composer` 的左右 padding（12px / 窄屏 9px）以与加号左缘对齐；隐藏的 `.image-input`、拖拽与粘贴三条附件路径不变。

- **中间过程组只装真正的中间过程：提问 / 引导 / 压缩改为单独展示**（用户 2026-09-25：「部分消息不会被放入中间过程组，而是单独展示，目前我规定提问、压缩应该单独展示，以及引导」）：`splitTurnStages()` 新增 `isSoloEntry()`，**引导块与自动压缩块**像「消息」一样成为分隔物、平铺在组之间（提问与手动压缩本来就会切断分组、已经在组外，工具结果仍整条留在组里）。连带三条：组标题不再统计引导 / 压缩（只算本段，轮次标题仍是全轮总数）；两类条目脱离 `.turn-stage` 作用域后自动不画时间轴圆点与竖线；另在 CSS 用 `.message:not(.user-steer):not(.compaction-message)` 把它们排除出「平铺正文发中性灰」那条规则（引导是用户说的话，压缩块在组内时本来也不是灰的）。

- **固定凭证（可选，默认关）**（用户 2026-09-25 问「token 凭证是怎么来的，每次都不一样？可不可以在设置里选固定凭证」，一轮选定：本机密钥 + 会话 id 派生 / 本机与局域网都固定 / 开关立即重启页面服务 / 带「重新生成密钥」按钮）：
  - 原本的凭证是 `startServer` 里的 `randomBytes(32)`，**只在冷启动新建服务时**换（`/reload` 与 `/web` ↔ `/web-wlan` 都沿用），所以地址收藏不了。现在开启后凭证 = `sha256(本机密钥 + 会话 id)` 的 64 位十六进制（与随机值同形状，前端 `TOKEN_RE` 认的就是这个）；本机密钥在 `~/.pi/atom/web/token.key`（首次开启自动生成，`0600`）。掺本机密钥是故意的：只用会话 id 派生的话，会话 id 一泄露（会话文件名、日志、`/status` 截图）就等于交出凭证。
  - 派生统一发生在 `withFixedToken()`，**所有启动路径都过它**（`/web`、`/web-wlan`、`/reload` 恢复、换模式、换凭证后的重启），于是同一会话任何时候的地址都一样。开关与端口同文件（`~/.pi/atom/web/config.json`）。
  - 开关当场换凭证：服务原地重启，**监听地址、私有端口、网关路由与短码都不动**（网关按短码 + 私有端口记账，不认识凭证），TUI 打新地址；新凭证与地址从动作响应里回到设置页（调用方此刻已鉴权），页面写回 `sessionStorage["atom-token"]` 并**自动跳到新地址**（给 1.2s 让新地址先显示出来；跳转前把当前面板 id 记进 `sessionStorage["atom-settings-return"]`，重载后设置页仍停在「Web 服务」；sessionStorage 写不进去时不跳，退化成新地址 + 「立即跳转」按钮）。坑：**只有 `#凭证` 变时给 `location.href` 赋值是同文档导航，浏览器不会重新拉文档**（而服务已在背后重启、旧凭证已失效，页面会停在半死状态），所以 `reopenAtNewUrl()` 先 `history.replaceState` 把片段抹掉再 `location.reload()`（不清片段就 reload，`consumeToken` 会拿旧凭证去鉴权）；origin/pathname 真变了才走 `location.assign`。
  - 新增「重新生成密钥」（带二次确认，动作 `rotate_web_key`）：所有会话的固定凭证整体换代，泄露出去的老地址随即失效；没开固定凭证时只换密钥、不动服务。
  - UI：「设置 → 会话 → 网关端口」改名「Web 服务」，新增「固定凭证」开关、新地址行与「凭证密钥」行（显示 `token.key` 路径）。协议：`configure_web` 多一个 `fixedToken`，新动作 `rotate_web_key`，`webConfig` 多 `fixedToken` 与 `tokenKeyPath`（**强制字段**，`shared/protocol.ts` 与 `.js` 两份同步改）。
  - 本轮按约定未写也未跑测试文件；派生与开关用一次性脚本在**临时 HOME** 里实跑 20 条全过（默认关、同进程派生稳定、64 位十六进制形状、开关落盘、只改端口不会把开关带回去、**跳进程仍是同一个 token**、不同会话 id 不同 token、换密钥后老 token 失效、密钥路径，另加 `shared/protocol.js` 与 `.ts` 各 5 条动作校验）。

- **多个会话共用一个固定端口（独立 Web 网关）**（用户 2026-09-25：会话 A 开了 `/web`、会话 B 也开，两个都要能访问，A 退出不能把 B 的页面弄挂；并追加「两个端口的选择写到设置面板里」）：新增 `extensions/gateway.mjs`（持有固定端口的独立进程）与 `extensions/gateway-client.ts`（pi 侧：端口配置、会话短码、拉起、注册与心跳）。
  - 地址从随机端口变成 **`http://<host>:31359/<会话短码>/#<凭证>`**（`/web-wlan` 是 31360，两种模式是两个端口，共一个端口就会串台）。一个端口同一时刻只能被一个进程 listen，所以各 pi 进程仍只听 127.0.0.1 的随机私有端口，把 `{短码 -> 私有端口}` 注册进网关，由它剥掉前缀原样转发（方法/头/体透传，补 `x-forwarded-prefix`，`host` 换成上游自己）。
  - **「A 退出带不走 B」是靠架构而不是顺序保证的**：网关由第一个 `/web` 用 `detached + unref` 拉起，不是任何 pi 进程的子进程，也不提供任何「关停」指令 —— `/web stop` 只注销自己那条路由，所以 stop 后网关还会活最多 60s（可能正服务着别的会话）；唯一退出条件是路由表连续 60s 为空。路由靠 20s 心跳续命，90s 无动静自动摘除（进程被强杀也不留永久死链）。
  - 短码 = `sha256(sessionId)` 前 5 位十六进制，**稳定**（`/reload`、重起 pi 开同一会话都不变，地址可收藏），所以路由表**不落盘**：网关被杀掉后各进程心跳会重新拉起并原地重登，短码与端口不变，页面靠 SSE 看门狗自己接回来。两个进程开同一个会话会撞码，网关回 409 + `suggest` 让后来者换后缀；同 pid 换私有端口（`/reload`）直接放行。
  - 端口可在**「设置 → 会话 → 网关端口」**改（用户级 `~/.pi/atom/web/config.json`，改完下一次 `/web` 生效；两个端口相同时服务端报错、页面就地显示报错行）。配置必须在后端而不是 localStorage：拉网关的是 pi 进程，读不到页面偏好。协议新增快照字段 `webConfig`（`{port, lanPort, gateway|null}`）与动作 `configure_web`，`shared/protocol.ts` 与 `.js` 两份都加了。
  - 前端因此改成**前缀无关**：`web/index.html` 的资源引用全改相对地址（网关把 `/ab561` 302 到 `/ab561/` 才能解析对），接口新增 `web/api/base.js` 的 `apiPath()` 按 `location.pathname` 拼（写死 `/api/events` 在前缀模式下会打到站点根）。`/id/` 模式下私有端口的服务跳过 Host/Origin 校验（只听回环、只有网关能到达），回环网关自己保留 Host 校验，局域网网关沿用不校验、且不对外列出会话清单。
  - **局域网实跑的返修**（用户 `/web-wlan` 报 `Ignored an import map value ... Bare specifier` + 白屏 + 字体 404）：上一轮把 `index.html` 的资源改成相对地址时，**importmap 的取值改成了裸的 `vendor/vue.js`** —— 它不是合法的相对 URL，浏览器把四条映射全部丢掉，紧接着 `Failed to resolve module specifier "vue"` 整页白屏（已改回 `./vendor/vue.js`；`<link>`/`<script>` 没这个限制，所以不能只测一处就算完）。同一轮抹掉剩下的绝对地址：`fonts.css` 里 7 个 `url("/fonts/*.woff2")` 改相对（前缀模式下原本全部 404），ask_user_question 包注入的样式 `<link>` 与 `CustomTerminal` 的 xterm `<link>/<script>` 改用 `apiPath()`。改完用真 `server.ts` 站在网关后面把整条链取了一遍（页面 / main.js / style.css / fonts.css / vendor 三个库 / shared/protocol.js / woff2 / 带凭证的 api），前缀与直连两种模式全绿。用户复测又抓到第二处：`web/api/*.js` 里的 `import "../../shared/protocol.js"` —— **模块说明符是按模块自身的 URL 解析的**，而静态服务把 `web/` 挂在 URL 根（少一层）：直连时多余的 `..` 被浏览器夹住、凑巧能用，前缀模式下会退到站点根、把会话前缀整个丢掉（`GET /shared/protocol.js` 404）。改成 `../shared/protocol.js` 后两种模式都留在前缀内；代价是这条说明符在 Node 里指向 `web/shared/protocol.js`，所以新增该转发层（`export * from "../../shared/protocol.js"`，只用于 Node 侧解析）。同时修了 `configuredAssets()` 的一处语义：**顶层 assets 表里的显式挂载必须优先于 `web/` 目录扫描** —— 原先扫描用 `set` 直接覆盖，新建的 `web/shared/protocol.js` 会把 `/shared/protocol.js` 这条挂载顶掉，浏览器拿到的是转发层、并在模块图里自我导入。
  - 拉不起网关（最常见是固定端口被别的程序占着）时退回以前的随机端口直连，并在 TUI 说清原因。
  - 本轮按约定未写也未跑测试文件；网关与接入层用一次性脚本实跑过（剥前缀转发、302、静态与 POST 透传、SSE 分块时延、抢码 409、注销与端口不符不误删、上游失联摘除、空闲自杀、冷启动、配置读写），并因此修掉两个真 bug：参数解析只认 `--port=1` 不认 `--port 1`（会让网关当场起不来），以及端口被占时要等满 12s 才报错。同步 DETAILS.md §2 §3、README.md。

- **手机端回车不再发送，只插入换行**（用户 2026-09-25：「在手机端，用户必须点击发送才能发送，用户的回车、输入法的回车应该被认为是换行」）：`ComposerDock.keydown()` 的 submit 分支加上 `!isCoarsePointer()`（复用 `web/stores/settings.js` 导出的 `pointer:coarse` 判据，与底部安全区让位用的是同一个信号），触屏设备上 Enter 不再 `preventDefault`，textarea 原生在光标处插入换行，`onInput` 顺带把草稿与高度跟上；桌面端行为不变（Enter 发送、Shift+Enter 换行）。输入法组合期的回车本来就被函数最前面的 `event.isComposing` 挡掉，现在即便提交候选词后再补一发回车也只会换行、不会误发。判据用 `pointer:coarse` 而非宽度断点：桌面窗口拖窄只是窄屏，键盘手感不该跟着变。斜杠命令菜单里的 Enter 仍是补全（补全不是发送，且菜单项本身可点）。行为改动但按约定未写未跑测试，只跑 `check`（通过）；既有用例不会红（套件默认是 fine pointer，`test/browser/web.spec.js:2802` 那个 touch describe 里只有底部安全区一条、不模拟回车）。同步 DETAILS.md §13。

- **窄屏把发送 / 停止按钮移到输入卡右侧，底边贴住正文下缘**（用户 2026-09-25 先拿手机截图圈了右侧那块空白，实现后又补「就算显示在右边，也应该是底部对齐」，追问后选定跟输入文字区底部对齐）：两个按钮原本挤在模型名右边。它们本来就在 `.compose-right` 里同位互换，所以只需在窄屏媒体查询里给 `#composer`（已是 `position:relative`）下的 `#send` / `#stop` 加 `position:absolute;bottom:calc(34px + 7px + 12px);right:9px`。这个底边距不是拍数：正文与 `.compose-actions` 在流里紧挨着没有 margin，所以操作行顶缘就是正文下缘，而操作行窄屏 `min-height:34px`（行内最高的图标按钮 32px）+ 卡片 `padding-bottom:7px` = 41px；用户随后要求「默认文本框高度时这个按钮看起来是垂直居中的」，几何居中是上下各 6.4px（默认正文 `3.2em` = 44.8px、按钮 32px），但目检后说「应该再往上一点」，余量抬到 12px（共 53px）；正文长高后仍贴底、只是不贴死；`right:9px` 就是卡片左右 padding。**定位轴用 bottom 不用 top**：正文会随内容长高（最多 16em），bottom 天然跟着正文底部走，不需要 JS 量高度。按钮脱流后正文最后一行与附件缩略图条（排在正文与操作行之间、带横向滚动）会从它下面穿过，两处各加 `padding-right:40px`（按钮 32 + 右边距 9，再让 1px）。宽屏完全不变。纯样式改动：按约定未写未跑测试，只跑 `check`（通过），目检交给 `/reload`。同步 DETAILS.md §15。

- **设置页把上下安全区显形（用户 2026-09-25：「当位于设置页面时，把安全区渲染为灰色，并且在中间显示文本 `(顶部安全区)`/`(底部安全区)`」）**：安全区就是 `.layout` 的上下 padding（`--safe-area-top` / `--safe-area-bottom`），设置页里正好能调这两个值，但页面上看不出边界。ChatView 在 `composer.view === "settings"` 时给 `.layout` 加 `show-safe-area`，CSS 用它的 `::before` / `::after` 画两条 `position:fixed`、`height:var(--safe-area-*)` 的居中灰条（`pointer-events:none`，不影响点击）。用 fixed 而不是 absolute：`.layout` 正好铺满视口，fixed 落在同一段 padding 上，而给 `.layout` 加 `position:relative` 会顺带改变其它绝对定位后代的包含块。配色走中性灰令牌 `--intermediate-text`（20% 打底 + 同色文字），`--panel` / `--muted` 带蓝调会被读成蓝灰色块；安全区值为 0 时条子高度为 0，自然什么都不显示。按约定未写未跑测试，只跑 `check`（通过）。同步 DETAILS.md §7。

- **状态栏按可用宽度逐级收紧（用户 2026-09-25 指定顺序）**：宽度不够时依次 1 会话名固定成「会话」→ 2 隐总计 Token → 3 隐轨迹事件数（步）→ 4 隐输入/输出 Token、同时把「总计」放回来（那时用量按钮只剩这一个数字）→ 5 隐对话轮数（轮）→ 6 隐成本（`$x.xx`，命中率与它同一个按钮、只收数字）。级数常量 `LEVELS` 与 style.css 里 `.status-bar.compact-N` 的条数两边同步。级别不按视口断点写死，而是 `SessionStatus.fit()` 量 `scrollWidth > clientWidth` 一级级试出来（会话名与数字到底多宽才是决定因素）；触发靠 ResizeObserver + `onUpdated`（数值每秒在变、位数也会变宽）。累加类 `compact-1..5`，CSS 只写「第 N 级新增隐什么」（第 4 级是唯一的反例：它反而要把第 2 级隐掉的总计放回，两条同特异度 (0,3,0)，靠「写在 compact-2 后面」压住，不得调序）；为此「19轮1034步」拆成 `.status-counts` 里的两个子 span（`turns`/`steps`），输入+输出包 `.status-io`、总计包 `.status-total`、成本拆成 `.status-cost`（与命中率原来只隔一个全角空格，拆开后用 `margin-left:4px` 补成等宽的 10px）；两组中间的分隔点改成挂在 `.status-speed::before` 上（文案里不再有 ` · `），所以隐掉哪一组都不会留下孤立分隔符。固定文案「会话」是常驻的 `.status-session-fixed`，靠 CSS 切显隐，不改文案也不重建按钮 DOM（DETAILS §16 硬约束）；`statusValues()` 保留 `conversation` 整串字段给弹层与既有断言。**窄屏不居中已修**：`max-width:760px` 那条媒体查询里原本给 `.status-bar` 写了 `justify-content:flex-start`（当时是为了「挤不下就横向滚动」），现在会压到不溢出，它就变成了「压缩完整条偏左」的成因 —— 只留 `overflow-x:auto` 兜底，居中回到基座规则。
- **模型选择与思考级别选择合成一个按钮（用户 2026-09-25 两张图：「把他们合并为一个，展示为模型名称和[思考级别图标]」）**：
  - 右侧只留 `#model-button`（`#thinking-button` 删掉），内容是「模型名 + 当前级别的仪表图标」（名字最长 210px 省略号，仪表图 21×14）；`title` 同时给出模型与级别。
  - 新面板 `web/components/composer/ModelThinkingPicker.js` 是图二那样的三段式：顶行当前模型名 → 点它**在面板内**切到「供应方 + 模型」两栏视图（左上角「← 返回」，`/model` 命令直接落在这一页）；中间是当前级别的「[仪表图标] 思考级别 · xxx」；底部是一根滑块，**档位就是后端下发的 `thinkingLevels`**（不是固定七档），轨道上的刻度点用 `left/right:24px`（16 padding + 8 半个滑块）对齐滑块中心。
  - 滑块**拖动即下发、面板不关**（用户选定）；下发失败会把手柄拨回真正生效的那一档（失败时值未变，Vue 不会自己写回 DOM）。
  - **忙碌/处理中也可以切**（用户补充要求）：Pi 的 `select_model` / `select_thinking` 要求空闲，所以忙时改为**只缓在浏览器**（`composer.pendingModel` / `pendingThinking`），按钮与面板立刻按待生效值显示并走橙色 `.pending` 标记，本轮结束（`busy` 转假）后自动补发：模型先发、再补思考级别；新模型不支持刚才选的级别时静丢。选了当前值就是取消排队。
  - 顶行与级别行都是**内容成组居中**（不是两端分开）：箭头/图标与文字 `gap:4px` 紧贴、整组水平居中；顶行字号 12px、级别行 13px（用户 2026-09-25：「文本和右边的图标紧贴在一起，然后再一起水平居中」）。需要把 `.picker-check` 的 `margin-left:auto` 在顶行里收回（写成 `.model-thinking .mtp-model .picker-check`，特异度 (0,3,0) 才压得住）。
  - 删除 `ThinkingPicker.js` 与 `.thinking-picker` 样式（用户选定「删掉，只留滑块」）；`ModelPicker` 去掉 `busy` prop（不再因忙碌而禁用模型行）并新增 `embedded` 内嵌模式。
  - 合并按钮的字号其实**从来不是 11px**：`.composer-setting{font-size:11px}` 的特异度是 (0,1,0)，一直输给后面 `.compose-actions button{font-size:12px}` 的 (0,1,1)。用户要求「字体也稍微缩小一点」，就写 `.compose-actions .composer-setting{font-size:11px}`（(0,2,1)）拿回真正想要的 11px；再小就改这一行（下一级 10.5px）。
  - 本轮未写也未跑测试（按约定），只跑 `check`（通过）；目检交给 `/reload`。同步 DETAILS.md §15。
- **思考级别弹层每行加仪表图标，三处选择弹层的选中勾改到右边**（用户 2026-09-25 给了一整套 reasoning gauge SVG 并要求「把他添加到`思考选择`这里」+「目前被选中的左边有一个✓，把这个✓全改到右边」）：
  - 源图已**入库留档到 `docs/assets/reasoning-gauge/`**（`01-off.svg` … `07-max.svg` 七张 + 两张整排预览图 + `README.md`，里面写了每张源图对应点亮哪一段、指针到哪）。`docs/assets/` 从此是设计源图的存放位：不产物、不被静态服务（`extensions/server.ts` 只扫 `web/`），所以**改源图不会自动生效**。
  - 图标仍由代码生成：`web/icons.js` 新增 `thinkingIcon(level)`，按 `GAUGE_TICKS`（七段刻度各自的 `rotate` 中心）与 `GAUGE_LEVELS`（每个级别点亮哪一段 + 指针末端坐标，`minimal` 与 `minimum` 同格）拼 innerHTML，并按级别缓存 vnode；未知/自定义级别按 medium 画而不是留白。
  - 源图颜色写死 `#20242A` / `#C8CDD3`（深色主题下会看不见），运行版改成点亮段与指针/轴心 `currentColor`、未点亮段是同色 28% 透明度，随按钮文字色走（未选中灰、选中深色）。
  - viewBox 从 128 整块裁到内容外框 `16 31 96 61`，配 CSS 的 19×12 槽位才能铺满；尺寸与颜色必须用 `.setting-picker button .gauge-icon` 写（同特异度且靠后），否则被 `.setting-picker button .ui-icon` 抢成 14px 与强调色。
  - 供应方、「显示全部」与模型行一并把勾从左边改到右边：行内结构统一成 `.picker-label`（`min-width:0` + 省略号）+ `.picker-check{margin-left:auto}`；label 不加 `flex-grow`，所以 `.show-all` 那行在没有选中项时仍居中。
  - 本轮未写也未跑测试（按约定），只跑 `check`（通过）；目检交给 `/reload`。同步 DETAILS.md §1（新增 `docs/assets/` 存放位）与 §15。
- **设置页一级导航：桌面列宽收窄、手机只显图标**（用户 2026-09-25 看着图标那版说「这个宽度太宽了」+「移动端仅展示图标就行，不展示文字」）：
  - 一级标签都是两个字，桌面导航列从 168px 收到 **76px**（10 + 16 图标槽 + 8 + 26 文字 + 10），选中底色条不再拖满。
  - 手机（≤760px）导航列 **44px 只放图标**：文字包进 `.settings-nav-label` 并在媒体块里 `display:none`，按钮 `justify-content:center` + `padding:9px 0`（点击区 44×34px），列间距 12px。400px 宽下内容列变成 288px。
  - **配套的可访问性**：可见文字被隐藏后按钮没有可访问名，因此一级按钮始终挂 `aria-label`（与可见文字同串）。同步 DETAILS.md §7。
- **设置页一级导航带图标**（用户 2026-09-25：「为这些一级菜单的左侧加上各自的图标」）：`SETTINGS_SECTIONS` 每项加 `icon` 字段 —— 常规 `theme`、会话 `chat`、定义 `spark`、关于 `help`（特意避开 `layers`：已被中间过程组占用；`trace`：已被「执行轨迹」页占用）。按钮变成 `display:flex; align-items:center; gap:8px`，图标是 16px 固定槽位 + 14px 本体且 `display:block`（去基线偏移，文字左缘统一在 34px），颜色跟文字走 `currentColor`（未选中灰、选中强调色），窄屏 108px 侧栏里四字仍不折行。纯渲染/样式改动：未写未跑测试，只跑 `check`（通过）。同步 DETAILS.md §7。
- **设置页大标题改成固定显示一级分类名**（用户 2026-09-25 红框指着头部那行「会话信息」：「这里应该固定显示一级设置菜单的名字，比如『会话』」）：h3 从 `current().title`（当前二级的标题）改成 `group().label`，于是「会话」下面不再重复写一遍「会话信息」，切二级 tab 时标题也不变（四个一级分别是 常规 / 会话 / 定义 / 关于）。`SETTINGS_SECTIONS` 里 tabs 的 `title` 字段从此只当备注、不再参与渲染（未删，删它要连带改测试与文档）。同步 DETAILS.md §7。
- **手机设置页与电脑显示一致**（用户 2026-09-25 拿桌面/手机两张截图对比后要求一致）：
  - 窄屏 `@media(max-width:760px)` 不再把设置页折成单栏、也不再让一级导航变成顶部横排 chip —— 手机仍是「一级导航在左、内容在右」的两栏，只把导航列 168px 收到 108px、列间距 24px 收到 14px。
  - 一并去掉窄屏的三条单独收窄：`.page` 的 `18px 18px` padding（改用桌面 `24px 28px`）、`.toolbar` 的 `0 18px`（保持 30px，否则 tab 行与内容错开 10px）、`.view-tabs button` 的窄屏 padding。手机与桌面从此只剩「导航列更窄」一处差异。
  - 400px 宽下内容列约 222px，靠 `.setting-inline{flex-wrap:wrap}` + `.setting-range{min-width:110px}` 让「数值框 + 滑块」放不下时换行而不是溢出。纯样式改动：未写未跑测试，只跑 `check`（通过），目检交给 `/reload`。同步 DETAILS.md §7。
- **长内容出现滚动条时正文不再左移（跳变）**（用户 2026-09-25：「主页面长时浏览器会出现滚动条，把主内容挤到左边」）：
  - 原因是 `#scroll` / `.page-pane` 是 `overflow:auto`，正文列却是 `max-width` + `margin:auto` 居中的：内容一溢出，内容盒窄掉一个滚动条宽（15px），居中列整体左移半个滚动条（约 7.5px）。
  - 两处都加 `scrollbar-gutter:stable` 常驻预留槽位，宽度恒定 → 不再跳。输入卡与回顶按钮的 `--scrollbar-width` 补偿（左移半个滚动条以对齐正文）保留不动，且因为槽位常驻，这个变量从此恒定，对齐也不再抖动；`availableWidth()` 用的 `#scroll.clientWidth` 同样变成恒定值。overlay 滚动条（macOS 默认、移动端）不占宽度，不受影响。
  - 纯样式改动：按约定未写未跑测试，只跑 `check`（通过），目检交给 `/reload`。同步 DETAILS.md §6。
- **设置页新增「关于」分类**（用户 2026-09-25 要求，排在一级最后）：
  - 三块内容 —— **版本与协议**（扩展版本 / 协议 schemaVersion / 实例 ID / 服务地址）、**运行环境**（浏览器与系统从 UA 解析、界面语言、视口与像素比、内容列可用宽度、安全上下文、访问方式 —— 末项读 resize 响应式的 `available`，顺带让缩放窗口时这一页能重画）、**使用说明**（快捷键、命令菜单、列宽调整、`/reload` 与「重新载入页面」的区别、断线自动重连）。
  - 版本走协议下发：服务端启动时从 `package.json` 读 `version`，以新的快照字段 `extensionVersion` 下发（`shared/protocol.ts` 与 `protocol.js` 两份都加了校验，允许空串、上限 64 字），`web/stores/session.js` 增加同名状态。因此**改了版本号要重启扩展**才会变。
  - UA 解析是导出的纯函数 `browserLabel()` / `osLabel()`（浏览器只取主版本号，识别失败回退成原始串前 48 字）。使用说明只列代码里确实实现了的行为。
- **设置页分类合并成两级：一级「常规 / 会话 / 定义」，每个分类内部再加一条横向 tab 栏**（用户 2026-09-25 指定，分两次要求：先合「会话」「定义」，再把外观与行为合进「常规」）：
  - 外观 + 行为 = 「常规」；会话信息 + 连接与实例 = 「会话」；技能 + 扩展 + 模板 + 定义 = 「定义」，其中原「定义」在二级里改名「其他」（大标题仍是 Agent 定义）。
  - tab 栏渲染在大标题下方、内容之上（用户红框那个位置）；视觉沿用顶部 `#view-tabs` 那套下划线样式，首个按钮去掉左内边距让文字与标题左缘对齐。「恢复默认设置」按钮仍只挂在二级「行为」上，打开设置页仍默认落在「常规 → 外观」。
  - 实现上 `section` 存的仍是「内容页 id」，一级高亮由新的 `findSection()` 反查，所以 `body()` 的分支一行没改；新增 `firstTabOf()`（点一级落在第一项）与 `nextSettingsTab()`（二级 ←/→/Home/End；`nextTab` 这个名字已被 ViewTabs 占用）。一级 ↑/↓ 现在按分类跳，同一分类的两个二级之间不会互跳。
  - **本轮按新约定未改任何测试文件**（见 AGENTS.md 测试策略）：`test/frontend.test.js` 的「settings sections cycle in the sidebar with the keyboard」与 `test/browser/web.spec.js` 的「top tabs switch between conversation and settings」「settings lists agent skills, extensions, prompt templates and definition」三条用例引用的旧入口（`data-section="skills"` 等）已不存在；另外「turning off auto collapse keeps middle steps open past the next user input」与「the settings tab controls theme, content width and behaviour, and remembers them」两条里的 `[data-section="behaviour"]` 也要改成先点 `[data-section="general"]` 再点 `[data-tab="behaviour"]`。共 5 条会红（Node 1 条 + 浏览器 4 条），需由用户调整。本轮验证只跑了 `check`（通过）。
- **消息区所有 tooltip 一律传送到 body（新增 `web/components/conversation/hover-tip.js`）**（用户 2026-09-25 就同一处反馈两次：「这块弹窗会被中间过程组挡住」）：
  - 第一次只把轮次徽标的时间浮层搬出去，其余五处仍留在正文里，所以还会被挡住 —— 本轮把机制抽成共用的 `PortalTip` 与 `useHoverTip()`，六处浮层全部改用：`TurnStatusBadge`（详细时间三行）、`IconTipButton`（复制/编辑/分支箭头的说明，工具卡与两条状态行共用）、`ProcessingStatus`（运行态开始时间）、`CompactionStatus`（压缩完成三行）、`UserPromptStatus`（提示词时间）、`CommandRule`（命令横线 ⓘ 的两行浮层）。
  - 根因（量过）：`#messages{isolation:isolate}` 把正文圈成一个堆叠上下文，里面有三级吸顶标题（轮次标题 20 / 中间过程组 10 / 卡片标题 2），折叠块基座又是 `.disclosure-block{overflow:clip}`；`.status-tip` 只有 9，正好被中间过程组压住。**光抬行内 z-index 治不好** —— 在 isolate 上下文里还得跟折叠块的 clip 比，抬到 30 一样会被裁（`.tool-block` 的圆点是同类前例）。
  - 现在：`Teleport` 到 `body` + `position:fixed` + 内联 `left/right/top/bottom`（四条边都写死、不用的写 `auto`，否则 top 与 bottom 同时生效会把浮层拉长），placement 与 align 由调用点声明（上/下、左缘/居中/右缘），间距 7px、观感不变；`.portal-tip{position:fixed;z-index:30}`（写在 style.css 末尾）压过正文最高的 20。
  - 一并补掉的三个代价：坐标是一次快照 → 展开期间监听 window 捕获阶段的 scroll 与 resize 立即收起；鼠标移进浮层靠浮层自己的 mouseenter/mouseleave 续命（浮层里的文本仍可选中）；`.status-tip` 基座去掉定位，原先靠子孙选择器定位的那几条（tip-button 的两条、user-prompt、processing-status[role=status]、compaction-done-time）与 `.command-rule-tip` 的定位段全部作废，图标按钮的 white-space/max-width 移到 `.tip-button-tip`。
  - 验证：check 通过（77 源文件 / 3 样式表）；**Node 159 全绿**；浏览器 **68 passed / 3 failed**（3 条仍是断言早已删除的 `.tool-output-frame` 等标记的既有基线债）。既有用例「user prompt status row…」改成断言 `body > .status-tip` 并钉住锚向（浮层在时间文字下方、右缘对齐），另加 `#messages .status-tip` 计数为 0 的防回归断言；「turn badge copy survives…」同批改断言。同步 DETAILS.md §18。
- **设置页顶部只留 8px、左侧导航不再继承旧侧栏的外边距**（用户 2026-09-25：「settings-page 不应该有 padding-top」「settings-nav 的 margin 不要有」）：
  - `.settings-page{…padding-top:8px}` 把 `.page` 的 24px 顶部留白收到 8px（用户先要求完全去掉，随后改为「加回一点小的」）；窄屏媒体块里那条 `.page{padding:18px 18px …}` 写在文件更后、同特异度会把它顶回来，因此同一个 `@media(max-width:760px)` 块内再补一次 `.settings-page{padding-top:8px}`。
  - 导航那 30px 上下 + 8px 负左右外边距来自文件开头给旧侧栏写的裸 `nav{display:grid;gap:6px;margin:30px -8px}`（侧栏 `<aside>` 现在根本不渲染），已限定成 `aside nav`，并给 `.settings-nav` 显式写 `margin:0`。**同一段里的 `nav button` / `nav button.active` 两条保持裸选择器**：问卷包的 `<nav class="ask-tabs">` 里非当前项按钮靠它们拿到透明背景与透明描边，一并限定会让那些按钮长出边框。
  - 验证：`check` 通过；浏览器针对设置页与 dock 的 5 条用例（含断言 `.settings-page` 的 `paddingBottom` 为 20px 那条）全绿。同步 DETAILS.md §7。
- **删掉标题行右侧的状态文本与标题行下的通栏分隔线**（用户 2026-09-25 两张红框：「已同步」与它下面那条线）：
  - `ChatView.js` 删 `activity()` 与 `h("span", { id: "activity" }, …)`，标题行只剩会话名 + 重命名铅笔；连带删 `#activity` 样式。连接/生成/排队状态本来在输入区状态栏与活动组件栏也有展示，标题行不再重复一遍。
  - `.toolbar-head` 去掉 `border-bottom:1px solid var(--border)` 与 `height:52px`，改成 `padding:10px 0 2px` —— 线与其下方多余间距一并收掉，标题行紧贴 tab 行（原来 52px 行高下实际内容只占 ~20px）。工具栏底边（`.toolbar` 的 `border-bottom`）与选中 tab 压在其上的下划线未动。
  - 无行为逻辑变更，无测试引用 `#activity`（已 grep 确认）；`check` 通过。同步 DETAILS.md §6。
- **消息区分流边界改成「这一轮是否结束」（重构，用户 2026-09-25 追问「live 必须独立渲染吗」后选定）**：原先按「消息是否完成」切分，导致正在进行的**同一轮**被劈成两个容器——已落定的部分在历史的 `<details>` 里、正在流式的部分在 live 区一个无标题续框里，于是反复出现「live 区临时多切出一组」「续框跟着历史折叠吗」「计数不实时」这类补丁。现在：
  1. `turnGroups.js` 新增 `splitRunningTail(messages, { running, hasPendingUser })`：把末尾那段还没被「消息」切断的 run（正在进行的那一整轮）从历史里摘出去；**乐观用户消息已出现但还没落库时不摘尾**（它已经代表新的一轮，否则会把上一轮的尾巴错并进来，落库后自动对齐）。
  2. 新增 `TurnGroupView.js` 的 `renderTurnGroup(group, { keepOpen, renderUnit, turnProps })`——历史区与 live 区**共用同一份轮次渲染**（各 feed 只负责决定单条消息怎么渲染：历史用 `historyTools` + 轮次徽标，live 用整轮的实时工具上下文且不挂徽标）。
  3. `LiveFeed` 从此渲染「整轮 + 正在流式的消息」这一个真正的轮次分组（`<details class="turn-group turn-live">`、`keepOpen: true`、`blockKey` 与它在历史里时同一个），历史区只渲染已结束的轮并传 `groupMessages(history, { running: false })`。于是分组（只以「消息」划分）、级联折叠、**轮次标题的计数全部实时更新**，且同一轮只有一份 DOM。
  4. 本轮结束后整轮移交回历史区（一次 DOM 重建），两边 `group.key` 相同 → 折叠状态与级联水位线按同一 blockKey 延续，不跳。
  5. 随之删除的补丁：`trailingTurnGroup()`、`LiveFeed` 的 `tailOpen`/续框 DOM、TurnStage 的 `bare` 属性（本轮先加后撤）、CSS `.turn-live>.disclosure-body{padding-top:0}` 与那条跨容器桥接线段的注释（`.turn-live{margin-bottom:8px}` 保留，仍用于容器下方间距）。
  6. 测试口径同步：`open()` 守卫改断言整个 `#messages`（会话忙时历史容器里没有正在那一轮，单独断言某个容器会误报）；「长历史 + 流式」「流式不重建历史节点」两条用例的 fixture 补一条**用户提问**，否则按新规则整段历史会被判成「正在进行的那一轮」；旧用例 `turn groups stay open after the turn ends…` 改名并改成 09-24 的折叠口径（本轮一结束立即折叠），组内消息/最终输出的排版断言改用两个容器的并集选择器；新增防回归用例「正在生成的卡片住在它所属那一轮的 details 里」（钉住整轮只有一个分组、计数 思考1→思考2 实时、移交后不重复）。
  7. 过程中误删：删除临时探针时算错行号锚点，把文件最后一条用例（context ring）的函数体一起删了，且该用例不在 HEAD 里 —— 已照 `ContextRing.js` 与 `contextUsageView()` 重写（钉住 `aria-label` 读数、`data-level`、null 不得当成 0%、弹层里「压缩上下文」以 `mode: followUp` 发出 `/compact`、busy 时禁用）。
  8. 验证：`check` 通过；Node **159 全绿**（新增 `splitRunningTail` 一条，含「移交后 key 相同」断言）；浏览器 **69 passed / 3 failed**（3 条仍是断言早已删除的 `.tool-output-frame` 等标记的既有基线债）。协议与后端未改动，`COMPATIBILITY-API.md` 未动。
- **中间消息默认改为黑灰**（用户 2026-09-25，同日两次口径）：夹在中间过程组之间的那些正文（轮次标题里计入「消息」的那几段）从正文色 `--text`（`#263747`）换成新的中性灰令牌 `--intermediate-text`（浅色 `#595959`、深色 `#a4a4a4`）——一条 `.turn-group>.disclosure-body>.message{color:var(--intermediate-text)}`；**先按 `--muted`（`#607487`）实现过一次，用户指出那是蓝灰、要的是黑灰**，故另立令牌而不是复用。只命中原来看起来与最终输出分不出层级的顶层平铺条目（组内卡片、用户与命令条目、最终输出都不受影响；live 区续框是 `div.turn-group.turn-live`，命中同一规则）。字号 / 行高 / 左缘仍与最终输出相同（浏览器用例已拆成两组断言：字号与行高相等 + 颜色 `rgb(89,89,89)` / `rgb(38,55,71)`）；该用例本地跑通过，`check` 通过。同步 DETAILS.md §9、README、CHANGELOG。
- **折叠行为重构：折叠只看本轮是否在进行，并新增级联折叠**（用户 2026-09-24 六条要求）：
  1. **轮次标题（轮次分组）**——进行过程中保持展开，**本轮一结束就立即自动折叠**（不再等到下一个用户输入开始）；过程中手动点过轮次标题就不再自动折叠（「手动过」只算轮次标题自己被点，组内展开某个组不算）；
  2. **中间过程组**一律默认折叠，**开始与完成都不会改变它的开合**（旧规则「只有正在生成的那一组自动展开」废弃）；
  3. **中间过程卡片**默认折叠，完成后也不改变（思考块与工具卡本来已是，本轮只是取消了 live 区的特殊处理）；
  4. / 5. **级联折叠**（新增）：手动折叠中间过程组 → 组内卡片一并收起；手动折叠轮次标题 → 其下所有组与卡片一并收起；父级再展开**不恢复**子级此前的展开状态（用户选定）；
  6. **活跃卡片不再特殊**：live 区正在长的那张卡片也收在默认折叠的组里，与已完成的完全一致，只是内容实时更新。
  - **实现**：新增 `web/components/conversation/cascade.js`（provide/inject 祖先链 `provideCascade` / `useCascade`，不用 `cascadeParents` 一路透传）；store 新增 `seq` / `disclosureSeq` / `collapsedSeq` 与 `markCollapsed()` / `openUnlessCollapsed()`，父级在**用户手动折叠**那一刻占一个全局递增序号（用序号而非 `Date.now()`：同豪秒内会丢先后顺序），子级开合被任一祖先的折叠序号压住则收起；两者不落盘，`applySnapshot` 时清空。`DisclosureBlock` 的开合从 setup 一次性快照改为**每次从 store 计**（否则级联写的是父级水位线、子级根本收不起来），`onToggle` 以 `value !== open` 区分用户动作与程序同步；`turnGroups.js` 的 `keepOpen` 塌缩成只看 `running`，`collapseLoaded` / `nextUserInput` 不再参与折叠判定。
  - 验证：`check` 通过；**Node 158 全绿**（新增「手动折叠父级会级联收起子级，之后子级自己展开则压过级联」；改写两条旧折叠用例）；**浏览器 68 passed / 3 failed**（3 条仍是旧工具卡标记的既有测试债），新增「折叠跟随本轮进行状态，手动折叠会级联收起子级」钉住六条，另有 3 条思考块用例补 `openLiveStages()`（活跃卡片现在埋在默认收起的组里，点击目标不可见）。同步 DETAILS.md §9、README、CHANGELOG；COMPATIBILITY-API.md 未动（无接口变更）。
- **中间过程组左侧加类型图标，并修展开组「吃掉」组内卡片图标的旧规则**（用户 2026-09-24：「为「中间过程组」的左边加一个合适的图标，并且当 hover 时这个图标变为待展开的三角，展开后展示为展开状态的三角，与中间过程的一致」）：
  - `icons.js` 新增 `layers`（两张叠片 = 一组步骤）；`box` 已被压缩块占用、`trace` 被「执行轨迹」页占用，所以另开一个。`TurnStage` 传 `icon:"layers"`，标题行从 `display:list-item`（原生三角）改成基座那套 `display:flex;align-items:center` —— 于是折叠态是图标、**hover 换成向右三角**、**展开后是向下三角**，完全复用中间过程卡片那四条 opacity 切换规则（包括 `.12s ease` 过渡），没写一份新的。几何：图标槽 16px + `margin-right:7px` → 标题从 23px 起；图标中心 8px，与组内时间轴竖线（8.5px）同列；行盒仍 `--stage-header-h:30px`，`align-items:center` 居中。
  - **顺手修一个上一层折叠带出来的真 bug**：`.disclosure-block:not(.turn-group)[open] .disclosure-type-icon{opacity:0}` 与相邻三条（`.disclosure-caret`、其 `::before`、`.caret-expanded`）用的是**后代**选择器，而折叠块现在会嵌在折叠块里 —— 一个**展开的中间过程组会把自己正文里所有卡片的类型图标一起 opacity:0 掉**（收起时只能看到三角）。收成 `[open]>summary …` 后只作用于块自己那一行，嵌套互不干扰。
  - 验证：`check` 通过；跑了一组相关浏览器用例（图标/hover 换三角、组结构、吸顶堆叠、live 时间轴、思考块默认收起、专用工具卡）**6 条全过**；同步 DETAILS.md §9 与 §12、README、CHANGELOG；COMPATIBILITY-API.md 未动（本轮是纯样式与图标）。
- **时间轴收进中间过程组，「消息」与最终输出同款**（用户 2026-09-24：「对于「中间过程组」和「消息」，不要有左边这些线。和「消息」，不要有左边这些线。这些线应该仅存在于「中间过程组」展开下的「中间过程」块中。另外我现在希望「消息」采用与「最终输出」完全相同的样式和字体大小」）：
  - **顶层去线**：时间轴的圆点与线段原本挂在 `.turn-group>.disclosure-body` 下（每个块自己的 `::before` / `::after`，加上中间过程组、压缩块、引导块的单独规则），所以轮次分组正文里的组标题行与平铺「消息」也各自长着一个点一截线。现在把整组规则的作用域收到 **`.turn-stage>.disclosure-body`**（圆点、线段、`.markdown` 上移、`turn-tail` 剪尾、组内压缩块与引导块）；组自身的 `summary::before` 圆点与 `::after` 引线、以及 live 区那条跨容器的桥接线段（`.turn-live>.disclosure-body::before`）一并删掉。
  - **顶层顶格、组内缩进一档**：`.turn-group>.disclosure-body{padding-left:18px → 0}`、`.turn-stage>.disclosure-body{padding:0 0 2px 18px}` —— 组标题与「消息」跟轮次标题、最终输出左缘齐平，只有展开后组内的块右移 18px（圆点中心 6.5px、竖线 8.5px）。用户选定的层级：外层顶格、内层缩进，而不是一条贯穿主轴。
  - **「消息」= 最终输出**：字号本来已一致（`.turn-group{font-size:inherit}`），差异只在 18px 缩进；顶格后两者左缘与 font-size/line-height/color 逐项相等（已写进浏览器断言）。**不得回归**：消息仍住在轮次分组的 `<details>` 里（折叠轮次标题时消息随之折叠），但中间过程组自身收起不影响消息可见。
  - 测试：浏览器用例补上几何断言（顶层 `::before`/`::after` 为 none、组内卡片圆点存在、消息与最终输出的左缘与排版相等），并把 live 那条「必须有桥接线段」改成「顶层不得有线」；**Node 157 全绿 / 浏览器 3 failed、67 passed**（3 条失败仍是旧工具卡标记的既有测试债）。同步 DETAILS.md §0 术语表与 §9、README、CHANGELOG；COMPATIBILITY-API.md 未动（无接口变更）。
- **轮次分组与中间过程之间加入一层折叠：中间过程组**（用户 2026-09-24：「轮次分组（折叠块）下是中间过程（平铺）然后是最终输出，现在需要给中间过程再加一层折叠，按照输出一段文字作为结束，比如：模型请求调用工具 - 工具返回结果 - 模型输出说明（这条就是「消息」）- 模型请求调用工具 - 工具返回结果 - 模型输出最终结果，那中间过程应该被分成两组，消息在中间平铺，两个中间过程各自折叠，最后输出最终结果」）：
  - 新结构 `轮次标题 → 组1 / 消息1 / 组2 / 消息2 / 组3 → 最终输出`。正文切分必须做到**块级**（一条 assistant 消息能同时含思考/工具/正文），新导出 `splitTurnStages(intermediate, groupKey)` 产出 `group.body`（`stage` 与 `text` 交替）与 `group.stages`；新组件 `TurnStage.js`（复用 `DisclosureBlock`，标题同格式行内代码徽片，`remember:true` 直接落盘开合）。
  - 三项用户选定口径：**组标题同轮次标题格式但只算本组**、**默认全部收起 + 只有正在生成那组自动展开**、**轮次标题保留全轮总数**。
  - 关键约束（都已写进 DETAILS §9）：思考块身份是 `${消息id}-thinking-${原始块下标}`，所以切片必须带 `blockOffset`（`MessageItem` 新入参），否则思考耗时与开合状态全错位；`contentBlocks()` 对**字符串正文返回空数组** —— 这种消息得平铺（归进组或丢掉都是错，丢掉就是「整条回答凭空消失」），而 `buildTurnGroup` 为最终输出留的空壳必须跳过；组内不得再缩进（要接着用轮次分组那条时间轴），原本挂在 `.turn-group>.disclosure-body>` 上的直接子代规则（压缩块、引导块的圆点与引线）因嵌套整组落空 → 放宽成后代选择器；吸顶变成三级（0 / 30 / 60）；live 区同样按 `body` 渲染且最后一组自动展开。
  - 测试：Node **157 全部通过**（新增 2 条：按正文块切组与 `offset`/标题/组 key，以及字符串正文不被吞掉）；浏览器新增 1 条钉住「组 / 消息 / 组」结构、默认收起、点开后的思考块 `data-key` 仍是原始下标、最终输出不进折叠块，并按新层级修正 4 条既有用例（轮次标题得用 `> summary .turn-title` 限定、组内内容得先 `openFolds()` 展开、三级吸顶 30→60）；本轮新写的浏览器临时探针（结构/几何/默认开合/吸顶堆叠）已删除。
- **失败的卡片只留一个报错框**（用户 2026-09-23：「对于失败的编辑，有下面这个报错的框就够了，右边这块删掉」）：上一版在状态行右侧还塞了一份报错首行摘要（`.state-reason`），与下方的 `.tool-failure` 块重复，而报错很长时（比如 edit 没匹配上的整句提示）会在右侧竖着排成一大列，把卡片顶得很宽。现在：状态行只有「编辑失败 + 路径 chip（hover 出复制）」，报错正文（`resultText(result).trim()`）**完整放在下方那个报错框里**，所以 `failureNotice()` 不再看「是不是多行」，有报错正文就渲染；`failureReason()` 与 `.state-reason` 样式一并删掉（折叠态摘要不变，仍是压成单行的报错信息）。浏览器临时探针验过：`.state-reason` 为 0、`.tool-failure` 为 1 且文本含首行、状态行行高仍 23px。同步 DETAILS.md §11 与 README。
- **所有工具调用块的折叠摘要改用工具输出**（用户 2026-09-23：「对于所有的工具调用块，如果摘要未被指定，那就使用工具输出作为摘要。当报错时，如果报错状态的摘要未被指定，则用报错信息作为摘要。作为摘要时：连续空格被视为单个空格，换行也被视为空格」）：以前工具卡在折叠态只有一行「工具名 · 关键参数」，收起后完全看不出结果。新增 `toolSummary(result, running)`：取 `resultText(result)`（**报错时这段文本就是宿主的报错信息，不用分叉**），按思考块同一口径 `replace(/\s+/g, " ").trim()`（换行、制表都算单个空格），接到标题末尾的 `.disclosure-preview` 上 —— 于是折叠态是 `bash · npm test · PASS 12 tests …`、`编辑 · src/b.ts · 未找到匹配文本： oldText: p`（失败行本来就整行标红，摘要跟着红）。两个口径细节：**没输出就不渲染摘要**（运行中且无 `partialResult`、或输出全空白时返回空串，不留一个孤零的 `·`）；**先截到 300 字再交给 CSS**（`MAX_PREVIEW`）—— CSS 本来就会折成一行加省略号，但几百 KB 的 bash 输出整段塞进一个行内 span 会拖垫布局。测试：`toolSummary` 新增 1 条（换行/制表压平、报错摘要、partialResult 回退、全空白不编摘要、超长截断），共 **155 条 Node 全部通过**；浏览器临时探针验了三种折叠卡（普通输出 / 报错 / 无输出）后删除。同步 DETAILS.md §11 与 README。
- **edit 卡片加上行内（词级）高亮，并修「失败的 edit 仍写成功编辑」**（用户 2026-09-23：「PI TUI的edit不光能显示被修改的行，还能高亮具体被改的哪些字段，Web UI 能不能实现。以及现在明明有些 edit 失败了，但消息还是写的成功编辑，在失败时这里应该写出失败原因/报错信息」）：
  - **行内高亮**：新增 `web/components/conversation/wordDiff.js`（无新依赖）。pi TUI 用 `diff` 包的 `diffWords` + 反色（`dist/modes/interactive/components/diff.js` 的 `renderIntraLineDiff`），这里用 **token 级 LCS** 自己算出 `{ removed, added }` 的变更片段，`annotateIntraLine()` 把它挂到 `parseToolDiff()` 的行上，`diffLine()` 把变更段包成 `.diff-word`（底色比整行重一档）。分词 `\s+|[A-Za-z0-9_$]+|…`，CJK 逐字；**行首缩进不参与高亮**（纯缩进变化就不做行内高亮）；**只在删/增行数相等时逐行配对**（不等时不猜对应关系）；token 超 900 放弃（LCS 是 O(n·m)）。结果 diff 与「只有参数」时的 hunks 回退视图都走它（流式阶段就能看到改了哪几个字段）。
  - **失败态**：`toolState` 改成四态 `running|done|failed|aborted`（旧写法是 `props.result ? "done" : "running"` —— **完全无视 `isError`**，所以失败的 edit 也写「成功编辑」）；文案走新的 `stateLineText()`（正在/成功/失败/已中止），失败行整行转红，报错正文完整写在状态行下方的 `.tool-failure` 块里（右侧不摆摘要，不与下方重复；见下一条目），失败时不再显示 `+N -M` 这类变更统计；read/write/edit 三个专用视图都补上（read 失败以前只剩一个红图标、无任何说明）；失败时仍保留「想改的 diff」（与 TUI 一致：预览 diff + 红字报错同时存在）。
  - 测试：`test/frontend.test.js` 新增 3 条（行内片段只圈住 `usage.output` → `averageSpeed(session)`、缩进不算改动、中文按字；行数组的配对与不配对；`stateLineText` 四种文案，以及报错正文就是 `toolResult` 的文本）），共 **154 条 Node 全部通过**；浏览器端用临时探针用例验了四种卡（成功的 edit 出 2 个 `.diff-word`、失败的 edit/read/write 状态行分别为 `tool-state-line tool-state-failed` 且文案含报错原因），用完即删。同步更新 DETAILS.md §11 与 README。
- **状态栏的 tok/s 不再偏慢一个量级**（用户 2026-09-23：「你目前的token速度是如何计算的，我感觉你算的偏慢特别多啊」，并指定「仅计算模型消息输出和思考输出的速度」）：旧算法是 `累计 usage.output ÷ (now − 分支最早一条 entry 的时间戳)`，也就是**会话平均输出速度** —— 分母把读消息、打字、会话挂着不动、工具执行（跑一次测试几分钟）、压缩与重试全算进去了，分子却只是模型生成的 token，且因为每秒拿 `now` 重算，这个数字只会单调下降。现在改成只看「模型生成正文与思考」这一段（新文件 `extensions/generation-timings.ts`）：
  - **分母**：内容块块级实测时长 —— 块首次在流式里出现开始、它后面出现下一个块（或整条消息结束）为止，与 `thinking-timings` 完全同一判据；排队、TTFT、工具执行、空闲全部不计。工具循环里每条 assistant 消息单独算一条观测。
  - **分子**：按字符折算的 token（`estimateTokens()`：CJK 0.7 token/字、其余 3.5 字符/token、按码点计）。**不用 `usage.output`**：provider 只给 `input/output/cacheRead/cacheWrite`（已核对 `pi-coding-agent/dist/core/agent-session.d.ts`），工具调用参数与正文混在一起拆不出来，而 write/edit 的大段参数往往占输出大头，收进分子会偏高、排掉又拆不出时间；所以速度按「正文 + 思考」折算，**Token 总量展示仍用 provider 的权威 `usage`**（两者职责不同）。折算有 ±20% 误差，但用户 2026-09-23 明确要求**界面不写「约 / ≈ / 估算」**，因此界面不给限定词（DETAILS §4 已记下它不是权威用量）。
  - **数据链**：累计量放 `stats.generation = {tokens, ms, messages}` 并落盘 `web-state.json` 新增的 `generation`（只存累计量；`session-state.ts` 新增 `generationTotals()` 归一化）；流式实时值走新协议字段 `liveGeneration = {startedAt, elapsedMs, estimatedTokens}`（`shared/protocol.ts` **与** `.js` 同步加校验；它随 `liveMessage` 的 patch 发，因为 `message_update` 不刷 stats）。结算点：`message_end` 正常结算、`agent_settled` 兜底（中止/强杀时用最后一次流式刷新到的估算），`session_start` / `session_switch` 族 / abort 清空跟踪器。**没观测到就显示 `—` / 「暂无观测」，绝不拿会被稀释的分母凑数**（扩展加载前的历史消息无法回溯，自然不计）。
  - **前端**：`web/components/status/format.js` 新增 `averageSpeed()`（历史累计 + 当前消息的实时观测**合算成一个均值**），`statusValues().conversation` 变成 `N轮M步 · 20.0 tok/s`；「对话」弹层只保留**一行**「平均输出速度」（行序：对话轮数、轨迹事件数、平均输出速度、活跃时长）—— 第一版做的「生成中实时速度（估算）」与「已观测正文与思考」两行以及标签后缀、「≈」前缀均被用户逐项砍掉（最终形态见 DETAILS §16）。
  - 测试：Node **151 全绿** —— 新增 `test/generation-timings.test.js`（中英文分开加权、代理对按码点、思考→正文→工具调用的块级时长切割与“工具参数那段时间不收”、消息体丢失时的兜底）与 `test/generation-persistence.test.js`（不开 Web/不接 SSE 也累计，且 20000 字符的工具调用参数不计入、落盘 `generation`）；bridge 新增一条（快照 `generation` 全 0 且 `liveGeneration` 为 null → 流式 patch 带 `estimatedTokens: 50` 与 `elapsedMs > 0` → `message_end` 后 `stats.generation.messages = 1` 且 `liveGeneration` 回到 null）；`session-state` 补 `generation` 落盘往返，`status.test.js` 按新口径重写速度断言。浏览器 63 passed / 6 failed（5 个是 HEAD 基线的工具卡测试债，1 个是已知的负载 flake，单跑通过）。同步更新 DETAILS.md §4/§16、README 与 `COMPATIBILITY-API.md`。
- **文档分层：`AGENTS.md` 从 84.7KB 瘦身到 7.7KB**（用户 2026-09-23：「AGENTS.md 文件好像内容太多了吧」）：该文件是每个 pi 会话都会自动注入的约定入口，却累积成 74 条超长条目（最长单条 7.5KB），严重挤占上下文。现将**全部 70 条详细约定逐字**搬到新增的 `DETAILS.md`（85KB，按主题分 23 节：架构/协议传输/扩展入口/持久化/UI 桥接/布局/偏好/消息区/轮次折叠/Thinking/工具卡/折叠块基座/队列/图片/Composer/状态桳/代码块/状态行/压缩/活动组件/package/问卷/验证），`AGENTS.md` 只保留**硬约束、`DETAILS.md` 索引（每节写明「什么时候读」）与待办原文**，并给出「只读对应小节、不要整篇读 `DETAILS.md`」的用法（`grep -n "^## 9\."` 或 grep 标识符反查）。搬运用脚本完成并逐字校验（70/70 逐字命中，仅 §23 「同步更新**本文件**」那条因拆文改为写明文件名）；`README.md` 补上两层文档的定位说明，`pi-package-compatibility` 技能的文档指引改指 `DETAILS.md` §21。
- **手动压缩不再钻进轮次折叠块**（用户 2026-09-23：「手动压缩不应该进入 `disclosure-block turn-group`」）：`/compact`（Web 或 TUI）是用户显式按下的**页面边界**，现在像命令记录一样单独渲染 —— 切断分组但不触发自动折叠，也不计入轮次标题的「压缩`n`」；**自动压缩**（上下文阈值 / 溢出恢复）仍算本轮的一步（发生在同一个 agent run 内部）。难点是**落盘的 `CompactionEntry` 不带 `reason`**（宿主只在 `session_compact` 事件上给），所以扩展按压缩条目 id 把原因记进 `web-state.json` 的 `compactionReasons`（上限 500，`session-state.ts` 新增 `reasonMap()` 仅放行三个枚举值），序列化时以新字段 `compactionReason` 下发；扩展未加载期间的旧条目走兼容路径 —— 与已完成的 `/compact` 命令记录配对（完成行被搬到块上那种）就算 `manual`，两者都拿不到时不下发、前端保持旧行为。协议（`shared/protocol.ts` / `.js`）新增 `compactionReason` 校验；前端 `turnGroups.js` 新增 `isManualCompactionMessage()`，`isProcessMessage()` / `isCompactionMessage()` 据此排除手动压缩。测试：Node **144 全绿**（新增：手动压缩切断分组且不计入标题、自动压缩仍计入；`compactionReasons` 落盘与非法值丢弃；bridge 断言手动块带 `compactionReason: "manual"`、自动块带 `"threshold"`）。顺带修一条**存量的竞态用例** `an image-only prompt…`：它断言「新到的队列项不自动展开」是旧规则（现行规则：新增/编辑/转换均自动展开），在全量套件里因 patch 到达时机竞态而飘红，已改为断言自动展开。同步更新 AGENTS.md / README / `COMPATIBILITY-API.md`。
- **模型名左侧新增上下文占比环**（`ContextRing.js`）：一整圈底图 + 从 12 点顺时针的用量弧（SVG、半径 7 / 线宽 3，`stroke-dasharray` = 周长 × 占比），颜色沿用全站三档状态色 —— <60% 灰、≥60% 橙（`--tool-running`）、≥85% 红（`--tool-failure`），**刚压缩完暂无用量时只画底图**（未知不等于 0%）。点击弹出当前上下文 / 最大上下文 / 上下文占比（明细行复用 `DetailRows`，`kind: "context"`）与「压缩上下文」按钮（走已有的 `send` 动作发 `/compact`，不新造 action；本轮正在生成或已在压缩时禁用）。数据端：`ctx.getContextUsage()` → 扩展侧 `contextUsage()` 归一化（旧运行时或 `contextWindow <= 0` 时整体 `null`；**不把 `null` 当 0**，`Number(null) === 0` 踩过），随快照下发并跟 `stats` 同一通道刷新（上下文只随 LLM 用量变化）；协议与前端各新增 `contextUsage` 字段与 `contextUsageView()` 分档。测试：Node 新增一条（快照带数值 → 压缩后变 `tokens/percent = null` → 旧运行时没有该 API 时退化为 `null`，全程不断连接）；浏览器新增一条（占比弧长度≈占比、弹层三项数值、点压缩发出 `{send, /compact, followUp}`、压缩后环降级为 `unknown`、点击外部收起）。同步更新 `COMPATIBILITY-API.md`（新增「上下文用量兼容接口」）、AGENTS.md 与 README。
- **修：正在生成的那一块上方、跨容器的那段线段短了一节**。上一轮把 live 续框的 6px 顶部内边距归零时，只把桥接线段的高度从 24px 改成 18px，却没有把它的起点上移：线段仍从 `-9px` 开始，而上一框的末位圆点在 -17.4 处，边界上方因此空出 11.3px（组内同位置只留 4px），看上去就是断了一截。现 `.turn-live>.disclosure-body::before` 改为 `top:-16px;height:22.5px`（实测线段 410.1..432.6，上一个圆点 400.8..405.8、首块圆点 438.1）：起点在上一圆点下方 4px、终点在首块圆点上方 5px，与组内每一段线段完全同一节奏。
- 引导送达的用户消息也归进被它插话的那一轮，并且**自己也是一个折叠块**：折叠态只有一行「引导 · 用户输入的文本」（单行、溢出省略号），展开态沿用原来的展示（右对齐气泡 + 状态行）；折叠块标题与思考/工具卡同一套形态，因此也占一个时间轴圆点。
- **修：轮次已经折叠了，正在生成的那块思考仍悬在外面**。live 区的续框是个普通 `div`（不属于任何 `<details>`），所以历史那个折叠框收起后它依旧全程可见，折叠形同虚设。现在 live 区的中间过程不再做特殊判断：新增 `trailingTurnGroup(messages, {nextUserInput, collapseLoaded, running})` 算出历史末尾那个还在长的折叠组，`LiveFeed` 用与 `TurnGroup` 同一份 `disclosures` 与默认值查它的开合，**折叠时整块不渲染**（用户展开上面那个框时它随之回来）；最终输出不属于折叠区，折叠了也照旧显示；新一轮刚开始（历史末尾没有折叠组）时亦照常显示。
- **修：压缩块进轮次后摘要整个不见了**（标题只剩「压缩 ·」）。`展开时藏摘要` 那条写的是后代选择器 `.disclosure-block[open] .disclosure-preview{display:none}`，而**轮次分组自己也是 `.disclosure-block`** —— 分组一展开，组内所有 `.disclosure-preview` 都被连带 `display:none`。只有用这个类的块会中：压缩块、通知、自定义 Entry（思考/工具卡用自己的 `.thinking-preview`/`.tool-title span`，所以一直没露馅）。现在限定成子代 `.disclosure-block[open]>summary .disclosure-preview`，只藏「这个块自己」的摘要。
- **自动压缩也有耗时了，形态与工具调用完全一致**：`session_compact` 的 `reason` 是 `threshold`/`overflow` 时（上下文阈值 / 溢出恢复），扩展按 `compactionEntry.id` 记一条 `{ startedAt, durationMs }`，落盘 `web-state.json` 新增的 `compactionTimings`（上限 500，刷新后仍在），序列化时以 `compactionDurationMs` 挂到那条 `compactionSummary` 上（协议同时接收该字段）。前端复用 `formatDuration()` 与 `.duration-collapsed`/`.duration-expanded`：折叠到秒、不足一秒 `<1s`、展开到毫秒，**不提供 hover 弹层**（用户明确要求与工具一致）。手动 `/compact`（含在 TUI 里执行的）不记、照旧只有块下方那行「压缩完成（耗时…）」，已有完成行时也不会重复给一个右侧耗时。
- 测试：Node 的压缩用例补上「自动压缩带 `compactionDurationMs`、手动 `/compact` 不给」与落盘往返；浏览器用例在原来的进轮用例里断言摘要没被分组连带隐藏（`从200,163个token中压缩` 高度 > 0）且折叠耗时显示 `34s`、展开档为 `34s 0ms` 且隐藏。共 141 条 Node 全部通过。
- **正在生成的那一块上方间距与组内行距对齐**：流式内容在 live 的无标题续框里，而续框继承了 `.turn-group>.disclosure-body{padding:6px 0 0}` —— 那 6px 是给**带标题行**的框留的呼吸空间，接在上一个框底下就多了：首行上方 14px（上个框 8px 下边距 + 6px）vs 组内 8px。现 `.turn-live>.disclosure-body{padding-top:0}`，跨容器行距回到 8px；顶部的桥接线段同步从 `height:24px` 改为 `18px`（它是按 6px 内边距算的，内边距归零后首块圆点也上移 6px）。


- **自动压缩没有再断开一个连续任务**：压缩（自动压缩与 `/compact`）就发生在同一个 agent run 内部，所以 `compactionSummary` 不再就是「切断分组的独立条目」，而是和引导消息一样归入所在轮的折叠块（`turnGroups.js` 把它加入 `PROCESS_ROLES`、新增 `isCompactionMessage()`）：不切断分组、不触发自动折叠，并计入新的 `counts.compactions`。只有压缩、没有其他中间过程的那一轮也会成为一个只带「压缩`1`」标题的折叠块（它本来就是本轮的第一步）。
- 轮次标题顺序改为「思考`x` · 工具调用`y` · 技能调用`z` · 消息`a` · 引导`s` · 压缩`n`」：前四段是「这一轮做了什么」按流程顺序，「引导」与「压缩」作为本轮元信息排在流程计数之后，**压缩固定垫底**（旧顺序是「引导」占最前）。样式不变，「压缩」沿用同一套行内代码徽片。
- 时间轴为压缩块单独补了一组规则：`article.message.compaction-message` **没有 `.body` 包裹**（直接是折叠块 + 完成行），所以原有那整组 `.body>*` 选择器全部落空 —— 并轮后时间轴会在它这里断成一截空白。现补 `.turn-group>.disclosure-body>.compaction-message` 的圆点（仍挂在 `summary` 以随吸顶标题固定）与线段（挂在 article 上），尾块同样用 `turn-tail` / `:last-child` 剪掉引线。
- 测试：Node 新增 2 条（压缩不切断分组、徽片计入标题并排在最后；只有压缩时也算本轮中间过程），`turnCounts` / `turnTitle` 相关断言改到新顺序；共 141 条全部通过。

- 活动组件的 **tab 标题支持 inline Markdown**：新增 `renderInlineMarkdown()`（`web/markdown.js`），走 `marked.parseInline` 只出行内标记（`` `code` ``、`**粗体**`、`~~删除线~~`），永不产生块级盒子；清洗比正文更严 —— `ALLOWED_TAGS` 只放行行内标签（无 `a`/`img`/`script`/`p`）、`ALLOWED_ATTR: []` 属性全清（链接降成纯文本，tab 自身就是可点击元素），`marked`/`DOMPurify` 缺席时退化为转义原文而不是空白标题。
  配套新增纯文本版 `stripInlineMarkdown()`，用于按钮 `title` 浮层与 `blockedMessage()` 提示行（否则会漏出带反引号的源码）；它摘 `*`/`_` 时只认词边界，`ask_user_question` 这类包名不会被剔成 `askuser_question`。
- **Prompt 队列 tab 由「消息队列 3」改为「消息队列 `3`」**：数量变成行内代码徽片，与轮次标题「思考`3` · 工具调用`5`」同一套语言；徽片样式挂在共用的行内代码规则上（把 `.activity-tab-label` 加进 `:is()` 列表），tab 内只补 `padding:0 4px;font-size:.92em;line-height:1.25`（上下内边距必须收掉，否则 26px 的 tab 会被撑高）。`textContent` 仍是「消息队列 3」，既有用例不受影响。
- 测试：Node 新增 3 条（inline 渲染只出行内标签 + 白名单无属性、无 marked 时退化为转义原文、`stripInlineMarkdown` 含包名下划线不被剔字）；浏览器新增 1 条 `activity tab titles accept inline markdown and the queue count becomes a code chip`，并实测徽片没把 tab 撑高（26px）且与 tab 垂直居中对齐（偏差 ≤1.5px、不溢出底边）。


- 输入框右下角**提交与停止合并成一个按钮**（原来执行中会在提交按钮左边多出一个停止键）：空闲 = 提交；正在执行且输入为空 = 停止顶掉提交；正在执行但输入非空 = 换回提交（点击排队 followUp）。「输入非空」按 `composer.draft.trim()` 或 `composer.images.length` 判定，**只插了图片、文字为空也算非空**（用户明确要求）。运行中的提交按钮 `aria-label` 改为「排队发送（本轮结束后提交）」。
  停止按钮顺手重做：与发送键完全同一套几何（32px 圆、grid 居中、无边框、15px 图标），配色改用项目唯一的红 `--tool-failure` —— 平时浅红底 + `inset` 1px 细描边，悬停填满实心红、active 压暗，带 `.16s` 过渡；图标从 10×10、`rx=1` 的大尖角方块换成 11×11、`rx=2.5` 的圆角方块。旧的 `#stop` 只在末尾被覆盖成 30px、其余沿用通用按钮的白底描边，所以看起来又小又灰。
  浏览器用例：新增 `the composer keeps a single button: send, stop, or send again once anything is typed`（覆盖三态互换、32px/圆形几何一致，以及贴图后回到提交按钮）。


- 活动组件栏：**点击当前正在展示的那个 tab 现在会折叠整栏**（原来是「点了没反应」）。折叠入口变成三个：点当前 tab、行尾最小化按钮、`Esc`；点其他 tab 仍然只是切换。
  过程中修掉一个隐藏的焦点 bug：折叠是分两段做的（`expanded=null` 先让位、`closing` 让大框多挂 160ms 播退场动画），tab 行是在 `closing` 清空那一刻才从大框顶部搬回输入卡上方、节点被重建，所以任何早于那里的 `focus()` 都会打在已移除的旧节点上（实测 `activeElement` 掉回 body）—— 焦点归还移到退场动画回调里；`focusTab` 也改成挑**可见**的那一份（动画期间同一 tab 在 DOM 里有两份，`querySelector` 先命中的是大框里那份隐藏的）。这条对最小化按钮与 `Esc` 同样生效。
  浏览器用例：新增 `clicking the tab that is already shown collapses the activity panel…`；`new or changed queue items reopen the panel…` 顺带把「点当前 tab 折叠」与「最小化按钮折叠」两条入口都覆盖；另有三处队列用例原本无条件点队列 tab 来「展开」，而队列 tab 会自动展开、现在这一点成了折叠，改为断言展开状态。


- 修掉时间轴在**流式期间「暂时断开」**的一个真缺口：历史折叠框与 live 框是两个容器，线段只由各块向下画一段，跨容器那 8px 边界上没有任何线，而正在运行的一项就贴在这条边界下面。现在在 live 框正文顶部补一小段接线 (`.turn-live>.disclosure-body::before`)，从上一个框的底边画到首块圆点上方，保留「圆点附近断开」的观感。另一半「暂时断开」是设计如此：按要求尾块不引线，而流式时尾块身份一直在变。


- 修复**Web UI 长期后台后切回来停在旧进度**：机器休眠/网络切换会让 SSE 变成半开连接，`reader.read()` 既不 resolve 也不 reject，而旧实现没有空闲检测 → 不报错就不重连。服务端本来每 15s 写一行 `: heartbeat`，所以客户端现在对字节静默设了看门狗（`idleLimitMs` 默认 40s）：到点主动 `abort()` 并**立刻**重连取新快照（不等指数退避）；`AbortError` 按来源区分，只有看门狗自己发起的才走重连，`stop()`/新连接的 abort 仍静默返回。新增 `resume()`，`AppShell` 在 `visibilitychange` 变为可见时调用：先 flush 后台期间合并的最后一帧（隐藏页 rAF 不跑），退避中则马上重试，沉默超过 `resumeStaleMs`（默认 20s）直接换连接；`ChatView` 在同一时机补一次滚底（仅当原本贴着底部时），因为跟随滚动的补帧也依赖 rAF。假 fetchImpl 必须把 AbortSignal 接到流上，否则测试里的 `abort()` 是空操作。新增两条传输层用例（半开连接被看门狗发现并重连、`resume()` 只在沉默过久时重连）。
- 顺带修正 `folding block titles stick…` 用例：它还在断言旧的单层吸顶（内层标题贴容器顶并盖住外层），改成断言两级堆叠（分组标题 `groupRel=0`、内部卡片标题 `innerRel=30`、各自行内命中自己）；「标题压在代码行号 gutter 之上」的判定从比 tagName 改为 `hit.closest("summary")`（命中的可能是标题里的图标/数量徽片 span）。


- 用测试固定住「扩展侧记录」这条契约：新增 `test/thinking-persistence.test.js` —— 不创建 HTTP 服务、不接任何 SSE 客户端，只驱动 pi 的 `session_start`/`message_start`/`message_update`/`message_end`，然后读 `.pi/atom/<sessionId>/web-state.json`，断言思考计时已按 `<sessionId>:branch:<entryId>-thinking-<块下标>` 落盘。依据是 `publish()` 的定时器无条件走 `windowedMessages()→displayMessages()→migrate→commit→persistState()`，面向客户端的只有 `server?.publish(...)`；所以**即使从没执行过 `/web`** 也会记录思考时间。


- 修复执行过程中**最后一个圆点下方悬空的线段**：「尾块不向下引线」的规则挂在 `turn-tail` 上，而只有 HistoryFeed 会加这个 class，live 时间轴框里正在生成的那张思考/工具卡没被标成尾块，线段就一直画到下方「正在等待模型响应…」状态行上方。现在 LiveFeed 也给 live 框的消息加 `turn-tail`，并补了一条结构兜底 `.turn-group>.disclosure-body>:last-child .body:not(.user-bubble)>:last-child::after{display:none}`；回归用例改成同时断言尾块 `::after` 为 `display:none`、圆点仍在吸顶的 `summary::before` 上。


- 修复正在生成的思考块耗时显示 `--`：计时本身早已是后端权威（`thinking-timings.ts` 挂事件流，Web 未启动/标签页后台也不丢），但流式期间后端**从不把进行中的 timing 发出去**，而浏览器只在「恰好抓到思考块仍是最后一个块的某一帧」时才会本地起表——标签页非活跃时补丁被合并，第一帧到达时 content 已经是 `[thinking, text]`，条目从未创建，于是只能显示 `--`。现在 `thinkingTimingsPatch()` 把已结算值（按历史消息 id）与 `thinkingTracker.streaming()` 的进行中值（按 live id，只有 `startedAt`）一起随 `liveMessage` 发布（thinkingTimings 是整体替换语义，必须一起发）；协议 `timings()` 允许 `durationMs` 缺席=进行中（负数仍拒绝），`web-state.json` 仍只收有 `durationMs` 的条目。补 tracker、协议与浏览器回归用例各一条。


- 修复折叠标题里的 `·` 分隔点在摘要很长时消失：标题行是 flex，而 `.tool-title span` / `.thinking-row span` 一类规则给行内所有 span 都加了 `min-width:0;overflow:hidden;text-overflow:ellipsis`，作为 span 的 `.disclosure-separator` 没有 `flex:none`，会被压缩到不足一个字符宽而被 clip 掉（只在摘要够长时出现，短摘要看不出）。现在给 `.tool-title/.thinking-row/.disclosure-summary-row` 里的 `.disclosure-separator` 补 `flex:none;min-width:max-content;overflow:visible;text-overflow:clip`，让溢出不定长的那段（摘要）自己收缩，分隔点始终占位。


- 正在生成的内容不再游离在轮次框外：`LiveFeed` 用同一个 `buildTurnGroup([live])` 把流式消息拆成「中间过程 / 最终输出」，前者装进无标题的 `.turn-group.turn-live` 容器（复用同一套 `padding-left` 缩进与圆点/线段时间轴），标题仍留在历史那个折叠框上，视觉上就是同一个列表在往下长；最终输出照旧在框外。没有并进历史的 `<details>`，以保留「流式只替换 live 区、不重建整段 transcript」的约束。
- **所有思考块默认折叠，包括正在生成的那一个**（废弃旧的「流式默认展开、下一个思考块开始时折叠前一个、整轮结束时折叠最后一个」）：`ThinkingBlock` 默认值固定 `disclosure(blockKey, false)`，`running` 只用于耗时结算与展开时的流式 Markdown；用户手动开合过仍以其状态为准（跨 live→历史 的 key 迁移不变）。


- **轮次分组正文的时间轴**：分组展开后内容右移一档（`padding-left:18px`），**每个块级条目（思考卡 / 工具卡 / 通知卡 / 正文输出块）左侧各一个圆点，圆点之间用一段竖线连接但带断口**。圆点与线段都挂在**卡片级** `.disclosure-block`（`::before` / `::after`）而不是 article 级 —— 一条 assistant 消息里的思考 + 多个工具卡共用一个 `article`，挂 article 只会在顶部出现一个点；且 `.tool-block` 默认 `overflow:clip` 会裁掉负偏移伪元素，所以组内卡片显式 `overflow:visible`（卡片内容各有自己的滚动容器，那层 clip 冗余）。线段 `top:21px;bottom:-14px`：从本卡圆点下方 4px 起、穿过卡片之间那 8px margin、停在下一个圆点上方约 5px，所以两个点之间是「连上但断开」；每卡各画一段因此不顶到分组标题，末位由 HistoryFeed 新加的 `turn-tail` 类（`intermediate` 末位条目，经 MessageItem inheritAttrs 透传到 article）配 `details:last-of-type::after{display:none}` 剪掉向下引线，最后一个点不再拖线。圆点色 `color-mix(in srgb,var(--summary-preview) 72%,var(--bg))`（比摘要灰浅一档、随主题），并改用 `border-radius:50%` 画圆（上一版 radial-gradient 羽化半径超过背景块一半会被切成「D」）。作用域严格限在 `.turn-group>.disclosure-body`。。追加两条：**正文输出块也有圆点**（点/线挂在 `.body:not(.user-bubble)>*` 块级，不再是只挂 `.disclosure-block`），以及**卡片展开时圆点跟标题一起固定** —— 卡片的点改画在 `>summary::before`（summary 是 `position:sticky` 的吸顶元素，绝对定位伪元素随它位移），滚过长正文时圆点会钉在分组标题下方；正文块的点仍画在块自身（没有吸顶标题可跟）。


- 轮次分组展开时的**两级吸顶**：分组标题本来就写了 `sticky;top:0;z-index:2`，但内部思考/工具卡片的 summary 同为 `top:0;z-index:2` 且 DOM 更靠后，滚动时会盖在轮次标题上（表现为「标题不吸顶」）。现在 `.turn-group` 定义 `--turn-header-h:26px`（标题行高），标题抬到 `z-index:3` 钉在顶部，`.turn-group[open] .disclosure-body .disclosure-block>summary` 的 `top` 改为该变量——卡片标题贴在标题下方，两个吸顶都保留。
- 上一项的跟进：标题的 `z-index` 从 3 抬到 **20**，并新增 `#messages{isolation:isolate}` 把整段正文（history + live）圈进独立的堆叠上下文。之前正文里的吸顶层与页面级浮层共用根上下文，z-index 一旦超过 `.compose-wrap` 的 4 就会画到浮动输入框上（正文滚过 dock 底下时标题糊在输入框上），因而只能勉强比内层多 1；隔离后正文内部的层号不再与页面级浮层比较，标题拿到 20 也不会越层（内层卡片标题保持 2，只需压得住代码行号徽的 1）。
- 修正上面两项其实**都没生效**：`.disclosure-block>summary{z-index:2}` 在文件中段，与 `.turn-group>summary` 特异度相同且更靠后，把轮次标题的 z-index 打回了 2（写 3 还是 20 都一样），所以内层卡片标题照旧盖住轮次标题。现在标题的 `z-index:20` 移到**文件末尾**显式覆盖；同时把标题高度改为由变量本身定义（`.turn-group>summary{box-sizing:border-box;height:var(--turn-header-h);line-height:calc(var(--turn-header-h) - 1px)}`，`--turn-header-h:30px`），内层 `top` 复用同一个值——之前写死的 26px 与带数量徽片的实际行高（~31px）不符，内层会钻到标题下方。

- 引导消息不再新开一轮：宿主在当前轮的工具间隙把它注入**同一个 agent run**，所以 `turnGroups.js` 新增 `isSteeringMessage()`（`role === "user" && delivery === "steer"`），`groupMessages()` 遇到它时**不切断分组、也不触发自动折叠**，而是归入被它插话的那一轮（气泡渲染在原消息流程的折叠块内）；`turnCounts()` 新增 `steers`，标题因此变成「引导`1` · 思考`45` · 工具调用`47`」（`TURN_COUNT_LABELS` 把引导放第位，优先级最高）。之前的写法会把同一轮切成两段中间过程（图中「思考45…」与「思考12…」）。`UserPromptStatus` 的「· 引导」仍保留，但它在折叠块内，所以折叠态下由标题的「引导`n`」承担。补了分组归属与标题顺序的 Node 用例。

- 用户消息状态行新增「引导」标记：以引导队列送达的消息在时间后显示「16:17 · 引导」（`·` 是独立节点，行本身 flex `gap:6px`）。Pi 落盘的用户 entry 不带任何来源标记（`_queueSteer` 只递 `{role,content,timestamp}`，宿主自己也是按「文本相等」摘除队列项），所以只能由兼容层推定：`prompt-queue.ts` 在发布快照时用 `trackSteering()` 记录**新出现**在引导队列的签名（`{FNV-1a}:{长度}`，文本+图片，上限 200），user `message_start` 时 `noteDelivery()` 核销，`index.ts` 把 `steeringSignature()` 追加进 `steeringDeliveries` 并落盘 `web-state.json`（上限 500）；序列化时按 branch 顺序消耗该多重集合，命中的用户消息下发新协议字段 `delivery: "steer"`（`shared/protocol.ts`/`.js` 同步校验，只接受 `steer`）。已知限制：只能覆盖扩展加载之后的消息（更早历史无留痕、不猜测）；引导项被删/改文字后留下的旧签名可能误标之后同文本的普通消息；旧运行时无 `_bindExtensionCore()` 时退化为不显示。细则写入 `extensions/COMPATIBILITY-API.md` 的「引导送达推定」。

- 轮次分组（TurnGroup）标题改版：由「12 次思考过程 · 12 次工具调用 · 1 条消息」改为「思考`12` · 工具调用`12` · 消息`1`」——类型名在前、数量在後，数量渲染为**与行内代码同一套标记**的小徽（`:is(.body,.markdown,.turn-title) :not(pre)>code` 扩了 `.turn-title`，字号/行高在文件末尾单独微调以垂直居中），分段之间用独立的 `·`。`turnGroups.js` 新增 `TURN_COUNT_LABELS` 与 `turnTitleParts()`（给页面渲染用的结构），`turnTitle()` 与 `group.title` 依旧给出同文案的纯文本；`TurnGroup` 新增 `titleParts` prop（无分段时回退纯文本）。

- 暂时隐藏顶部「轨迹」与「上下文」tab：`VIEW_TABS` 仍保留四条，但两项标上 `hidden`（轨迹另有 `disabled`），渲染与键盘切换改读新增的 `VISIBLE_TABS`，页面只剩「对话」与「设置」。`DEFAULT_VIEWS` 收窄为 `chat`，旧记忆里存的 `defaultView: "context"` 在载入时回落到对话页；只有一个候选视图时设置页不再渲染「打开页面时显示」，行为分类标题改为「折叠行为」。轨迹视图与 `ContextView` 代码全部保留，将来各自改为独立页面后去掉 `hidden` 即可接回（已写入 AGENTS.md 与 README.md 的「待办」）。

## 0.3.0 — 2026-09-13

- 状态行交互细节：图标按钮新增自绘 hover 文案（助手徽标「复制消息」、用户状态行「修改消息」/「复制消息」），去掉系统 `title`；助手侧「开始/结束时间 + 总耗时」详细浮层改为显示在状态行**上方**（此前会在下方压住消息正文，且 `right:0` 以时间文字为锚会向左越出内容列，现改以状态行左缘对齐）；新增可复用的 `IconTipButton`（`ProcessingStatus.js` 导出）统一「图标 + 浮层」结构。图标按钮本体必须显式中和全局 `button,select{padding:6px 12px;border:1px solid;background:var(--bg)}`（否则实测 26×18 比外壳 18×18 宽，向外溢出、把相邻按钮的 4px/8px 间隔整个吃掉——表现为「按钮不是方的、间隔没生效」）：`IconTipButton` 把 `class` 从 `attrs` 解构出来留在外壳，尺寸/圆角/透明度由状态行类提供，本体 `.tip-button-control` 撑满外壳；按钮统一为正方圆角矩形（18×18、分支 16×16，`border-radius:5px/4px`）。用户状态行的浮层随后按要求改回**下方**（助手徽标与 live 运行态在上方）。助手徽标的复制按钮也改为与用户状态行一致：平时隐藏（`opacity:0` + `pointer-events:none`），hover 或键盘聚焦整条模型消息时才淡入，时间文字始终可见。

- 用户提示词状态行：每条普通用户消息气泡下方新增右对齐状态行 `[编辑] [复制] < x/y > 18:09`。`x/y` 为同一逻辑分叉点下的兄弟分支（平行会话）序号/总数，仅 `count > 1` 时显示，首末分支禁用对应箭头；归组时跳过第三方扩展在 Prompt 前写入的普通 custom/状态 entry，因此 `appendEntry()` 不会使编辑后的新分支漏掉 `2/2`。时间为该消息时间戳（本地 HH:MM，hover 显示完整时间戳）；编辑/复制按钮平时隐藏、hover 整条消息时淡入。复制为提示词原文纯文本；编辑会让气泡就地变成编辑框（预填原文、只读图片缩略图、Enter 不提交、Esc 取消），提交后服务端中断当前生成，把被编辑的用户 entry 交给 Pi 的 `navigateTree()` 定位到该消息之前，再以新文本（带原图片）重发；新消息成为原消息的兄弟分支，原分支保留可切回。修复了此前自行导航父节点、首条消息直接 `resetLeaf()` 导致 Agent 上下文未同步，以及 HTTP 返回后把已结束的重启状态重新置回 true 的问题。分支切换通过 `historyRevision` 替换旧分支窗口，避免把两条兄弟分支纵向拼在同一页面。`<`/`>` 在同一会话文件内切换分支且不生成分支摘要。为此新增兼容层 `extensions/session-tree.ts`（优先使用 Pi runner 的命令上下文导航，内部 AgentSession 作为回退）、协议字段 `timestamp`/`branch`、action `edit_user_message`/`navigate_branch` 与快照 `restarting`；旧运行时不支持时降级（不显示分支控件、不报错）。

- 修复消息正文里嵌套 `.body` 的结构问题：`MarkdownContent` 统一渲染 `div.markdown` 作为 markdown 内容根，`.body` 只保留为消息/预览/输出面板的排版容器——消息正文、思考块、通用工具输出都不再套第二层 `.body`（此前 `article > .body > .body` 会让正文块看起来「插在中间」）。排版规则改用 `:is(.body,.markdown)` 同时覆盖两种容器，问卷预览框与工具输出框的专属规则同步改用 `.markdown`。

- 问卷核对页改进：答案按行展示并编号——勾选项依次 `1.` `2.`…，用户自定义输入用 `X.` 标记（`answerItems()` 纯函数，`answers.js`）；「修改」按钮缩小为紧凑小按钮并移到每题标题行右侧；`.primary` 主按钮（提交答案/核对与提交）补上 hover/active 状态，不再回退到通用 `button:hover` 的浅灰底（浅色主题下白字灰底对比不足）。
- 设置页新增「技能 / 扩展 / 模板 / 定义」四个只读分类（Agent 定义展示，不展示主题——PI TUI 主题与 Web UI 不兼容）：技能与模板取自 `pi.getCommands()` 的真实加载清单（含 npm 包与扩展动态上报的资源），扩展按 pi 目录发现规则镜像扫描（全局/项目/两级 settings.json/npm 包），定义展示上下文文件（AGENTS.override/AGENTS/CLAUDE 加载链）、SYSTEM/APPEND_SYSTEM、settings.json、packages 声明与项目信任状态；项目未受信时不列出项目级资源，与 pi 真实加载一致。后端新增 `extensions/agent-resources.ts` 与快照 `agentResources` 字段（`shared/protocol` 双端同步校验），前端 `SettingsView` 分类导航扩为八类，列表卡片统一带来源 chip（全局/项目/包名）。

- 新增「执行状态」组件 `ProcessingStatus`（最新消息正下方，替代并删除旧页脚组件 `ResponseWaiting`）：运行中按优先级显示 阻塞 > 正在调用 X 工具 > 正在思考 > 正在压缩上下文 > 正在等待模型响应 > 正在处理；计时基准改用服务端 `processingStartedAt`（prompt 被宿主接管时置位，跨越整轮，刷新/重连不从 0 重来）。
- 上下文压缩状态接入：扩展订阅宿主 `session_before_compact` / `session_compact`（含 `_failed`），压缩期间显示「正在压缩上下文...」，不再误报为「正在等待模型响应」；压缩结束刷新历史，让 compaction 摘要条目进入页面。

- 命令横线（`CommandRule`：命令 / 模型切换 / 已中断）改为与其它顶层条目一样包在 `<article class="message">` 里，间距交给 `#message-history>*` 的 8px 节奏（`.command-rule` 自身 `margin:0`，不再自带一套 10px 上下边距），并新增默认插槽用于在横线下方挂命令自己的执行状态行。`/compact` 因此有了执行状态：压缩中显示「正在压缩上下文...（x秒）」并每秒计时、hover 在上方弹开始时间（复用 `ProcessingStatus`，`CompactionStatus.js`）；压缩成功后同一行显示「压缩完成（耗时2分钟48秒）」，hover 弹开始/结束时间与总耗时（浮层在 120ms 延迟内可移入保持打开）。运行态只叠加在 `displayMessages()` 的序列化输出上、不落盘（中途退出/刷新不会残留转不完的计时），只有完成时的 `{startedAt, endedAt}` 写进那条命令记录。压缩结束后 branch 里的 `type:"compaction"` 条目被转成 `role:"compactionSummary"` 消息，渲染为「压缩」可折叠块：标题 `压缩`、折叠摘要 `从150,722个token中压缩`（拿不到 `tokensBefore` 时退化为「上下文已压缩」，不编造数字）、展开是压缩摘要全文（Markdown）。协议同步校验 `tokensBefore` 与 `compaction` 字段；新增 `CompactionStatus.js`、`compactionPreview()` 与 `compactionDoneText()` 纯函数，并补服务端（`/compact` → 运行态 → 完成态 → 压缩块 → 落盘）与前端文案两组测试。

- 压缩状态的两处修正（按用户实测反馈）：① **只有一条**运行态 —— 压缩中状态挂在 `/compact` 命令横线下方（带 `（x秒）` 计时与 hover 开始时间），底部 live 区不再重复显示压缩状态，也不回退成「正在等待模型响应」（压缩期间模型根本没被等待；`LiveFeed` 按「消息里是否存在带 `compaction` 且无 `endedAt` 的命令消息」判定，TUI / 自动压缩没有命令记录仍照旧显示在 live 区）；② **「压缩完成（耗时34秒）」移到「压缩」折叠块下方** —— 落盘的完成态由 `displayMessages()` 在序列化时从命令记录**移交**给配对的 `compactionSummary`（`entry.parentId === record.anchor`），前端在 `article.message.compaction-message` 里渲染「块 + 其下一行状态」（间距沿用 `.message>.processing-status` 的 8px）；页面上因此是 `命令：/compact` → 压缩块 → `压缩完成（耗时34秒）`。分支里没有对应压缩条目时完成态留在命令记录上，不留丢失完成行的死角。

- 折叠块标题吸顶：`summary` 改为 `position:sticky;top:0;z-index:1;background:var(--bg)`，滚动长内容（思考、工具输出、轮次分组、压缩块）时标题留在滚动容器顶部、随时可点击折叠；为此折叠块的 `overflow` 由 `hidden` 改为 `clip`（`hidden` 会建立滚动容器，sticky 会以它为参照而永不触发），嵌套的折叠块（轮次分组内部的思考 / 工具卡）同样吸顶：吸顶位置一致，内层包含块更小、先吸顶，块结束后被推走并露出外层标题；两层同时在顶部时按绘制顺序由内层盖住外层（因此 `background` 必须不透明）。`原始 Input` 这类二级折叠区不是 `DisclosureBlock`，保持 static。吸顶标题的 `z-index` 取 2 而不是 1：正文里的吸顶层（代码块行号 gutter `.code-lines`、diff 行号 `.diff-gutter`）都是 `sticky;z-index:1`，平级时它们按 DOM 顺序盖住标题（实测现象：代码块行号列压住吸顶标题），2 压得住它们、又仍低于页面级浮层。新增浏览器用例覆盖「各层吸顶 + 内层盖住外层 + 贴顶几何 + 标题压在代码块行号列之上」。
- 「等待模型响应」状态扩展：已提交尚无输出（preflight），或**刚调用完工具、模型还没开始出字**的窗口，都显示「正在等待模型响应...」。
- 每轮执行状态落盘：`agent_settled` 时服务端按该轮**最后一条 assistant 消息的客户端 id** 结算一条 `turnProcessing` 记录（`{startedAt, durationMs, status}`，status 区分 `done`/`interrupted`），持久化进 `web-state.json`；前端把「已完成（时长）/已中断（时长）」徽标渲染在**该轮最后一条消息的 `<article class="message">` 内、`.body` 的兄弟节点**（MessageItem 的 `status` 插槽，直接位于消息下方；正常轮次是组外最终输出，中断轮次是组内最后一条 assistant，组折叠时随组隐藏），刷新后依旧显示。 已完成徽标（TurnStatusBadge）显示为「17:07（耗时2分钟48秒）[复制图标]」：时间=完成时刻（startedAt+durationMs），hover 时间文字弹浮层（开始时间/结束时间/总耗时三行，完整时间戳），浮层锚在状态行左缘、显示在下方、可移入保持打开；复制按钮（icons.js 内联 SVG）复制该消息最终输出全文（text 块按空行拼接，纯思考消息不显示按钮），成功短暂变对勾、两条复制路径（clipboard API 800ms 超时竞速 + execCommand 兜底）都失败时显示「复制失败」2 秒。运行态状态行（LiveFeed 的 ProcessingStatus）hover 同位置弹单行「开始时间：完整时间戳」（无起点不弹）。
- 每轮「已完成/已中断（时长）」徽标的位置调整：不再是消息外的独立条目，改为渲染在该轮最后一条 assistant 消息的 `<article class="message">` 内、`.body` 之后（MessageItem 的 `status` 插槽，HistoryFeed 按消息 id 查 `turnProcessing` 传入）；中断轮次整轮在折叠组内时徽标随组折叠隐藏。运行态状态行（正在思考/工具/等待模型响应等）仍保持在 live 区最新消息下方，轮次结束后不常驻。
- 剪贴板写入健壮性（web/clipboard.js）：navigator.clipboard.writeText 加 800ms 超时竞速——Windows 上剪贴板被占用时该 Promise 可能永久挂起，原实现会静默卡死；超时或异常后走同步 execCommand 兜底（保持用户激活窗口内执行），仍失败则抛错由调用方给出可见反馈。 已完成徽标改版为 `17:07（耗时2分钟48秒）[复制]`：时间=完成时刻（startedAt+durationMs），hover 时间在下方弹三行浮层（开始时间/结束时间/总耗时，完整时间戳）；复制按钮（icons.js 内联 SVG）点击复制该轮最终输出全文（text 块按空行拼接），成功变对勾、两条复制路径都失败时短暂显示「复制失败」。运行态状态行（正在思考/工具/等待等）hover 同样在下方弹「开始时间：完整时间戳」浮层（无起点时不显示）。
- 强杀兜底：PI 在工具运行中被强制结束时 `agent_settled` 不触发、原有「已中断」行缺失；`displayMessages()` 在会话空闲时从 branch 推导「有 toolCall 无对应 toolResult」的挂起轮次，合成一条「已中断」提示行（纯派生、不落盘、刷新后重建一致）。
- 报错去重：报错只由「已中断」提示行承载——`stopReason` 为 `error`/`aborted` 且正文为空的助手消息（如 429 报错卡）在服务端历史里滤掉（带部分正文的保留），前端 `MessageItem` 不再渲染 `errorMessage` 红段，同一段报错不再出现两次。
- 状态提示行限宽：`.command-rule-body` 上限为容器 70% 宽，文字（含行内 code）单行超出省略号截断，全文由右侧 ⓘ 的 hover 浮层给出。

- 新增 `extensions/COMPATIBILITY-API.md`，统一定义“兼容层 API”，记录 Prompt 队列、UI 对话、自定义 Entry、第三方 package 按需适配、工具事件安全归一化、历史窗口与 Web 派生状态的接口、回退路径和 Pi 内部版本依赖。
- Prompt 队列改为完整保留多模态用户消息：队列卡片显示并可全屏预览图片，编辑器支持选择、粘贴、拖入与移除图片，纯图片项也可编辑、转换和删除；兼容层读取 Pi 真实 agent 队列，修复纯图片项消费后残留，并在重建队列时把图片继续传给 `steer()` / `followUp()`。移除 Web 自定的 4 张、单张 8 MiB、合计 16 MiB 和 HTTP 24 MiB 限制，图片能力由 Pi、模型与 provider 决定。
- 修复 Web 提交含图片 Prompt 时队列可能停留在 Pi 较早发出的纯文本 `queue_update`：兼容层现在在 prompt preflight 确认已启动或排队后再次发布包含完整图片的权威队列。纯图片 Prompt 的空文本保持合法，运行中提交后直接显示在 Follow-up 队列，不提前进入主会话。
- 修复 Prompt 提交与队列展示：输入框现在提交即清空、明确失败时恢复；运行中提交只进入 Follow-up，不再先闪现或残留为主会话用户卡；活动 tab 改名为“消息队列”，删除面板内重复标题，面板始终显示引导和排队两个分组，引导使用浅色背景；新增、编辑或转换时自动展开，并让新增或修改后的具体消息边框闪烁两次，删除和正常消费不触发。
- 新增「状态提示」横线条目：命令、模型/思考级别切换、被中断三类都渲染成 `-----文字-----`（左右两段线夹居中文字）。模型与思考级别的切换**统一**显示为 `模型已切换为\`模型 · 级别\``（不再单独为思考级别出提示），且**只提示最后一次** —— 连续切换多次再输入时不会把中间过程全部输出（`pendingStatusNote` 单值覆盖，不用「值没变就不记」去重，否则会漏掉 A→B→A 的最后一次）。
- 中断提示统一为红色「已中断（：原因）」：用户中断与模型/工具报错**不再区分文案**（原先 error 显示「模型出错」、工具显示「操作已中断」），能取到原因时拼成 `已中断：XXX`。分割线用 flex 行内实心块（`height:1px`）而非 `position:absolute;top:50%` —— 后者在行高为奇数时落在半像素上，1px 会被渲染成 2px，同一页里时粗时细。
- 修复中止产生的固定措辞被重复显示：宿主写 `Operation aborted`（工具结果）、Node 侧写 `This operation was aborted`，这些情况已由红横线表达，因此消息正文（`errorMessage`）与工具卡输出都不再单独显示；判定抽到 `web/components/conversation/abort-notice.js` 共用，用**整段精确匹配**而非「包含 aborted」，避免误吞正常输出里的同名词。
- 静态资源改为按需解析：静态表是启动时扫描的，之后新建的前端文件不在表里，浏览器取 ES 模块（不带 `Authorization`）会拿到 401，必须重启 `/web`；现在表未命中时用 `resolveWebAsset()` 现读 `web/` 下的文件。边界仍是严格的 —— `resolve` + `realpath` 双重前缀校验（挡住 `..`、绝对路径与指向外部的符号链接）、扩展名白名单（`.js/.css/.html/.json/.svg/图片/.woff2/.ico`，`.ts`/`.map`/`.env` 不放行）。

- 精简消息队列活动组件：删除面板底部重复的排队输入区，将 Steering 引导与 Follow-up 排队改为上下单列排列；两类队列总数为 0 时不再因模型正在生成而显示“队列 0”。
- 修复连续提交 Prompt 偶发出现 `Agent is already processing a prompt` 的运行时错误：不再把 fire-and-forget 的扩展 `sendUserMessage()` 返回当作发送已就绪，而是等待 `AgentSession.prompt()` 的 preflight 确认，确保后一条可靠进入 Follow-up，同时不等待整轮模型完成。
- 完善消息队列活动组件：普通输入与活动内新增消息默认进入 Follow-up 排队；队列项可转为 Steering 引导当前轮、转回排队、编辑文本或删除。更新操作使用 revision 与派生 ID 防止并发误改，并返回修改前、修改后条目及最终队列。
- 新增活动组件架构文档，记录当前数据模型、优先级、自动展开与折叠、状态保留、阻塞语义、键盘/ARIA、浮层滚动、视觉规则，以及新增核心活动和第三方 package 活动的接入边界。
- 新增 Prompt 队列兼容层和活动面板：实时同步 steering/follow-up 队列及总数，支持添加两类 Prompt，并以 revision 防并发误删的方式删除单条且返回完整删除信息；补充 Pi 系统、RPC、扩展与 Web 队列 API 文档。
- 新增活动组件栏（输入卡上方）：按优先级与到达时间排列带图标和名称的 tab，当前接入扩展交互请求与 Prompt 队列；点击负责展开或切换，最小化按钮与 `Esc` 负责折叠。展开时 tab 行升到面板顶部，非当前内容保持挂载以保存问卷草稿和终端状态；扩展请求可自动展开并按 package 定制外观，Prompt 队列不会自动展开。活动栏作为绝对定位浮层，不改变输入 dock 高度、消息留白或滚动位置；面板内滚动不会穿透到主会话。tab 使用三态 tone 配色、完整左右边框和统一中性面板边线，并支持深色主题、键盘循环导航及 reduced-motion。
- 修复问卷 preview 忽略换行与缩进的问题：preview 是 Markdown，但默认解析会把单换行折叠成空格、CSS 又会折叠连续空格，ASCII 预览会被压成一整行且列对不齐；现在 preview 开启 GFM 硬换行（`MarkdownContent` 新增 `breaks` 属性，仅预览使用），并给预览内部的**叶子块**加 `white-space:pre-wrap`（`.ask-preview .body :is(p,li,td,th):not(:has(>p,>ul,>ol,>blockquote,>pre,>table))`：容器保持 `normal`，否则引用/松散列表项内部的换行会变成空行；写到 `.body` 会把块间空白变成多余空行，只盖 `>p` 又会漏掉列表/表格）；预览框内块间距统一为 8px 节奏、容器（引用/列表项）内部段落外边距归零（原先浏览器默认 `margin:1em` 会把引用块从 23.8px 撑到 47.8px）；预览正文加一层与代码块同一套视觉语言的面板框（`--panel` 底 + 描边 + 圆角 + 内边距，选项卡选中色仍只在外框上）；预览正文字体同时对齐代码块的 `font:12px/1.65 var(--font-mono)`（原先字号与字体族已相同，仅行高 19.2px vs 19.8px）。
- 修复多选题的四个交互 bug：勾选/取消其它选项会错误地取消自由文本行的勾选态（`custom` 不能由 `text` 反推），先勾自由文本行再点其它选项也会被取消；自由文本行的勾选态现在是完全独立的存储。
- 修复单选框输入自由回答时 `kind` 被误写为 `multi` 导致提交报「无效多选答案」的回归（单选的自由回答必须是 `kind:"custom"`，多选题恒为 `multi`）。
- 对齐 ask_user_question 适配与宿主 2.9.0 契约：多选的勾选与自由文本改为**两个独立存储**（互不清空、可共存，提交时文本作为额外 `selected` 项）；修掉自定义输入框会清空已勾选项、取消自定义勾选会清空文本、点任一选项会取消自定义勾选三个 bug；「已作答」统一由 `isAnswered()` 判定。
- 修复 registry 把历史 prompt 事件重复注入适配器、导致**第二个及以后的问卷静默退回通用终端**的 bug（连续提问现在每次都能认领）。
- package 载荷的字段级 schema 从 `shared/protocol` 移回包模块：后端 adapter 认领前用宿主问卷上限校验工具调用，Web 渲染前用 `sanitizeQuestions()` 再裁一次，协议层只保留通用有界校验（JSON 可序列化 + 总长度）。
- 统一折叠块状态色为三态：正常灰、警告橙、报错红；工具调用失败时整行（类型图标、标题、单行摘要与耗时）标红，运行中/成功不再使用橙/绿，`read SKILL.md` 技能卡也不再单独着紫。
- 修复提交 prompt 后延迟历史刷新绕过窗口、把完整会话一次性载入 Web 导致卡顿的问题；刷新仍只发布最近 10 轮，旧历史仅在用户到达顶部时每次加载 5 轮。
- 重做通用工具正文：Input 直接使用 JSON 代码块，Output 去掉内框并默认按 Markdown 渲染；两者使用主会话背景，Output 内代码块取消高度上限与纵向滚动。
- 修正通用折叠块图标的垂直对齐；折叠态 hover 使用紧凑的实心向右三角替代原细线图标，展开态使用实心向下三角并隐藏标题后的 `·`。
- 修复长会话“懒加载”在连接后每 120ms 自动补页造成的持续卡顿：首屏保留最近 10 轮，只有滚到消息区顶部才加载一页更早历史，并保持补载前的阅读位置。
- 首屏不再下载约 489 KB 的 xterm 或挂载不可见的上下文/设置页；它们改为首次使用时通过本地资源按需加载。

- 折叠/展开块重设计：去掉外框与底色、标题统一灰色并统一为「图标 + 类型 · 标题」，图标在折叠态悬停时换成折叠三角、展开态为展开三角（120ms 过渡）；工具调用的状态色改落在图标上；通用工具卡改为「顶行入参 + 复制、下方输出」的单面板。

- 系统工具适配补齐 grep/find/ls：INPUT 用可读参数行（模式/路径/文件过滤/上限等），标题主参数按工具取（grep/find 用 pattern）；结果作为逐行原文展示，不再被 markdown 改写（路径里的 `_`、`*` 会被改写）。

- read/bash 卡微调：工具自己的截断/继续读提示语不再写进代码块，改为代码块之外的备注行；两者的 INPUT 都换成专门视图（read：逐项可读参数；bash/powershell：对应语言的代码块展示命令），原始 JSON 收进「原始 Input」折叠。

- 工具卡适配补齐：`edit` 的 diff 改为整块横向滚动且行号 gutter 固定（不再每行各自滚动）；`read` 结果按路径语言高亮、行号从 `offset` 开始；`bash`/`powershell` 结果作为终端原文展示（不再被 markdown 改写）。`codeBlock()` 新增 `startLine` 选项。

- `edit` 卡片展示宿主算好的 diff，带**文件行号**（`+123 内容` / `-123 内容` / ` 123 内容`，与 TUI 同一格式）；结果未回来时回退到参数推算，行号列留空而不编造。

- 新增 pi 系统工具的专门适配（写在核心代码里，不入 `packages/`）：`write` 直接展示高亮的写入内容（按 `file_path` 推断语言，含行数与复制），`edit` 展示 `-`/`+` 变更（支持 `edits[]` 与单个 `oldText/newText`）；两者原始 JSON 收进「原始 Input」二级折叠。同时修正工具标题参数顺序：`file_path` 优先于 `path`，read/write/edit 的标题不再缺路径。

- 调整自动折叠时机：中间过程块改为「下一个用户输入开始时」才折叠（不再随整轮输出停止而折叠，命令/通知等非用户条目只切断分组），用户手动操作过则不再自动折叠；思考块改为「下一个思考块开始时折叠前一个、整段回话结束时折叠最后一个」；加载（首次快照 / `/reload`）时已加载的中间过程全部折叠。

- 长会话加载更快：首屏只加载最近 10 轮并全部折叠中间过程；更早历史改为滚动到顶部时逐页加载，插入时不会跳动。
- 手机端软键盘弹出时（触屏设备 + 焦点在可输入元素上），底部安全区自动让位且不改配置值，避免把输入框顶得更高；失焦后恢复。
- 设置 → 外观：内容列宽度与安全区都提供滑块，最右侧统一用图标一键还原默认值（已处于默认值时禁用）。
- 上下文与设置页不再显示输入框与状态栏（dock 保持挂载、用 CSS 隐藏，`--compose-height` 归零，底部空间让给页面内容）。
- 设置 → 外观新增安全区：顶部/底部安全距离（px，0–240），写成 `--safe-area-top/-bottom` 并由 `.layout` 的 padding 消费，用于避开手机刘海、状态栏与浏览器工具栏的遮挡；随其他偏好存 `atom-settings`。
- 顶部 tab 调整：轨迹 tab 暂设为不可选中（执行轨迹将改为独立页面，视图代码保留但无入口，也不再作为默认视图选项）。
- 修复切 tab 卡顿：消息区改用 `visibility` 隐藏并保留布局（不再 `display:none`），页面作为叠加层；300 轮会话实测「设置→对话」107ms → 41ms、「上下文→对话」130ms → 48ms，且滚动位置与滚动条宽度不再抖动。
- 设置页改为左侧分类导航 + 右侧内容（外观 / 会话信息 / 连接与实例 / 行为，支持 ↑/↓/Home/End，窄视口折叠为横向）。
- `npm run check` 额外拦截 CSS 行首的 `//` 注释（CSS 里非法，会静默吃掉紧随其后的整条规则）。
- 新增顶部页面 tab：标题行显示会话名与重命名按钮（复用 `/name`），下方 tab 为对话 / 轨迹 / 上下文 / 设置，切 tab 保留消息区滚动位置，←/→/Home/End 可用键盘切换。
- 新增上下文页：上下文构成、Token 用量、缓存与成本，以及分支摘要与上下文压缩摘要条目。
- 新增设置页：主题（浅色 / 深色 / 跟随系统）、内容列宽度（与拖动列宽共用记忆）、会话信息、连接与实例、默认视图、自动折叠中间过程与自动跟随最新消息；偏好存 `localStorage`（`atom-theme` / `atom-settings` / `atom-content-width`）。设置页为左侧分类导航 + 右侧内容。
- 状态栏弹层与会话信息行的渲染拆分到共用的 `DetailRows`。
- 新增 `/web-wlan`：让网页服务监听 `0.0.0.0`，局域网内其它设备可打开同一会话；已有服务时就地重绑并复用端口与凭证（已打开的页面不失效），URL 取第一个非内部网卡地址并在 TUI 列出其余网卡，`host` 随 `connection` 交给 `/reload` 交接。该模式按约定暂时不校验 Host/Origin（凭证为唯一凭据），安全加固已列入 AGENTS.md / README 的「待办」。
- 修复 `@juicesharp/rpiv-ask-user-question` 2.9.0 使用间接 `Session` 构造后未被 package adapter claim、Web 错误退回通用 custom 终端镜像的问题；保留旧版 `QuestionnaireSession` 工厂识别。
- 将 Pi 第三方 package 兼容的目录规范、按需加载机制、静默缺失原则、后端 claim/Web 动态组件契约和测试要求提取为项目级 `pi-package-compatibility` skill。
- 新增 `extensions/packages/` 与 `web/packages/` 的按需第三方兼容架构：只有检测到对应 package 的公开事件或实际 Web 请求时才动态加载，未安装时静默跳过。将 `@juicesharp/rpiv-ask-user-question` 兼容完整迁入独立目录并更新到 2.9.0，新增全局备注及完整结果字段支持。
- 新增按“轮”折叠的中间过程：每轮从用户输入到最终输出之间的思考、工具调用、技能调用与中间正文收进一个 `TurnGroup` 折叠块，标题按固定顺序显示「x 次思考过程 · y 次工具调用 · z 次技能调用 · a 条消息」（为 0 的分段省略，没有中间过程则不显示标题），最终输出留在折叠块之外。折叠块内复用现有消息与工具卡渲染；标题行左上角是原生三角、标题下有一条分割线（无右侧箭头、无左侧灰线与子级缩进），分组在整轮输出完全停止后才自动折叠（执行中与消息间隙保持展开，以会话 `busy` 为准），用户手动操作过则保持其选择；折叠区内的中间消息与最终输出同款排版；通知、命令、摘要与终端输出各自独立并切断分组，执行轨迹视图仍平铺。
- 调整消息自动跟随：仅在滚动区位于最底部时跟随新内容，用户向上滚动后立即暂停，回到底部自动恢复；移除工具栏“最新消息”，离底时在输入框上方显示圆形跳转按钮。
- 修复快速流式 Thinking 增长时点击跳到底部仍可能落后的竞态：点击会先恢复自动跟随，并在当前 DOM 更新及下一渲染帧再次校准到底部。

- 修复行内代码看不出是代码的问题：全站基础字体本身就是等宽字体栈，行内 `<code>` 原来只有 0.9em 字号、无背景无描边，与正文几乎无法区分；现改为 `--panel` 底色 + `--border` 描边 + 5px 圆角 + `1px 5px` 内边距，并支持长 token 折行时每个片段独立成框。围栏代码块不受影响（不加双重外框）。
- 折叠块整体更紧凑：所有可折叠卡片（Thinking、工具调用、TUI 通知、自定义 Entry、markdown 折叠块）的摘要行高从 1.6 降到 1.45，卡片摘要内边距从 9–10px 降到 7px，通用 `details` 内边距从 `10px 14px` 降到 `7px 12px`——折叠态卡片高度由 39–41px 降到 33px。
- 对话区垂直间距统一为唯一值 8px：原来消息之间是 27px、消息内部是 10px 两套节奏（顶层孤儿工具卡、通知、自定义 Entry 还会混用两者），现 `#message-history>*`、`.message` 与消息内 `.body details` 全部为 8px，不再出现第二套间距。
- 修复长会话中出现的空白块：历史条目的 `content-visibility:auto` 会把被跳过的条目只渲染成“记住高度”的空盒子，现已移除该规则。
- 移除助手消息的角色标签（原来显示 `PI`），对话区不再出现该字样。
- 新增图片 prompt：输入框左侧按钮支持多选图片，页面支持拖放、输入框支持剪贴板粘贴，提交前可预览和移除；支持纯图片或图文同发，并在 Web 用户消息中立即显示图片。协议与后端按 PNG/JPEG/GIF/WebP、最多 4 张、单张 8 MiB、合计 16 MiB 做双重校验。
- 图片消息改为右对齐的缩略附件条，多张 80px 方形图片排列在独立用户文字气泡上方；纯图片消息不显示空气泡，发送前预览同步使用方形卡片样式。
- 输入框附件与会话图片新增共享全屏预览：点击缩略图按原比例放大，可通过 SVG 关闭按钮、遮罩或 `Esc` 退出，并把键盘焦点还给原图片。
- 新增内容列宽度调节：鼠标移到消息区左右边界时，在鼠标高度出现一条两端渐隐的细线手柄，拖动对称改变消息区、输入 dock 与状态栏共用的列宽（默认 860px），双击或键盘 ←/→ 可调整与恢复默认；宽度记在浏览器本地，窄视口不提供。
- 读取 `SKILL.md` 的 `read` 调用按技能卡展示：判定与 pi 宿主一致（仅 `read` 工具、路径 basename 为 `SKILL.md`、大小写敏感、`file_path` 优先于 `path`），折叠标题改为 `skill` 加技能目录名，整卡使用紫色（`--tool-skill`）与普通 `read` 区分。
- 修复长会话下输入框与状态栏整体右移的问题：消息列在 `#scroll` 内容盒内居中、dock 却在 `main` 内居中，出现纵向滚动条后两者错开半个滚动条宽度（实测 15px 滚动条错位 7.5px）；现将滚动条宽度写入 `--scrollbar-width` 并让 dock 左移半个滚动条，二者重新对齐。
- 降低拖动内容列宽度的开销：每个动画帧只写一次宽度变量、读一次几何，环境读数改为缓存，手柄位移走合成层。实测真实内容（32 条消息 / 4698 个节点）约 106ms/帧，未达 60fps；后续可通过“拖动时只预览、松手再应用宽度”进一步改善。曾试过的 `content-visibility:auto` 已移除：它只把数字降到约一半，却让被跳过的条目变成看不见的空白块，并放大 scrollHeight。
- 通用转发所有 `pi.appendEntry()` 自定义会话 Entry：后端观察 Pi 已注册的 TUI renderer，生成并清洗折叠态/展开态文本，与任意 `customType` 及有界安全 JSON 一同纳入协议；Web 卡片优先显示 TUI 文本，并将 JSON 收入“原始数据”，不再按 `wj-scheduler-status` 等插件类型单独适配。
- 统一折叠卡片摘要为单行：连续空白与换行压成一个空格，宽度不足时显示省略号；自定义 Entry 的 renderer 正文使用通知正文的默认字体，无 renderer 的对象数据折叠显示 `[JSON OBJECT]` 并在展开后使用 JSON 代码块，其他值按纯文本展示。
- 抽取 `DisclosureBlock` 作为 Thinking、工具调用、TUI 通知和自定义 Entry 的共用折叠基座；TUI 通知改为默认折叠并可展开查看全文。
- 修复 `/reload` 初始化空窗内的 `ctx.ui.notify()` 未进入 Web：替换实例在首次异步状态加载前恢复通知桥，并把期间收到的调度器、Pi 核心及恢复状态通知合并到项目级会话记录；仅连接地址继续绕过镜像。
- 移除产品顶部标题栏和左侧会话栏，对话区域改为占满整个浏览器视口；会话详情继续从底部状态栏打开。
- Thinking 与工具调用的折叠耗时不足一秒时显示 `<1s`，展开后仍显示精确毫秒。
- 修复思考耗时把后续输出一并计入的问题：同一轮内思考块之后一旦出现正文或工具调用，思考立即结算；只有消息末尾仍在生成的思考块继续计时，并在整轮结束时结算。
- 将 Pi 会话文件未保存的 Web 派生状态写入项目 `.pi/atom/<sessionId>/web-state.json`，支持 `/reload` 和进程重启后恢复 Thinking/工具耗时、折叠状态及命令/通知镜像；使用版本化校验、防抖和原子替换，并预留但不创建全局 `~/.pi/atom/`。
- `/reload` 在完整协议校验前先识别新实例并刷新，避免旧浏览器协议因新增字段拒绝 Snapshot 后无法完成版本切换。
- 修复 Pi 内存消息含 `undefined` 可选字段时首个 SSE 快照被预校验拒绝、网页始终显示连接断开的错误；协议现按实际 JSON 传输形态校验快照与增量。
- 将浏览器界面迁移为 Vue 3、Pinia、Vue Router memory history 与本地原生 ESM；不增加前端构建步骤，固定 import map 使用 CSP hash。
- 新增前后端共享协议校验与带流标识、序号的 SSE 快照/字段增量；实时消息更新不再发送完整历史。
- 修复工具运行事件含循环引用、`BigInt`、异常 getter 或过大私有数据时 SSE 被主动断开；工具事件现会归一化为有界 JSON，无法编码的单条事件也不会关闭连接或消耗序号。
- Web 提交 prompt 后立即显示临时用户消息卡，并在真实会话消息到达时无重复替换；提示词模板和技能命令也会绑定对应模型轮次。模型超过 1 秒尚未响应时显示按秒更新的等待提示，首个 assistant 事件、发送失败的轮次结束或取消到达后自动清除。
- 后端协议校验器改用 `.ts` 入口，修复 `/reload` 后仍复用旧 `.js` 模块、因不认识新增快照字段而让 Web 永久停在“连接中”的问题。
- 普通 prompt 在浏览器点击发送的同一帧先显示临时用户卡片，不再等待重载后首次 action 的冷启动往返；明确发送失败时撤销，并移除会误删正常慢 preflight 卡片的固定超时判断。
- 消息、工具、Thinking、输入框、选择器、状态弹层和扩展请求改为独立组件，保留会话草稿、问卷预览和终端交互；资源在退出时清理。
- 增加递归语法检查、协议与桥接测试、真实浏览器回归，覆盖局部流式更新、问卷提交、模型选择和重载；测试不触达真实模型或会话。

## 0.2.49 — 2026-09-13

- 在 `.agents/skills/` 安装 9 个外部 Codex 项目技能，覆盖前端设计、Vue、Pinia、Vue Router、Node、可访问性、响应式与交互设计。
- 新增项目专用 `pi-vue-nobuild` 技能，禁止前端构建工具、SFC、JSX/TSX、React/Nuxt 与依赖外部 CDN，约束 Vue/Pinia/Router、实时连接清理和流式状态隔离。

## 0.2.48 — 2026-09-13

- Thinking 与工具调用卡片的运行时间改为相对标题行绝对定位，在折叠和展开状态下均垂直居中。

## 0.2.47 — 2026-09-12

- Web 新增 `/model`、`/session`、`/copy`：分别打开已有模型选择器、会话信息卡，以及复制最后一条助手文本。
- Web 新增 `/name <名称>` 与 `/compact [指令]`，通过 pi 公开 API 设置会话标题和触发上下文压缩。
- 上述 Web 命令加入斜杠命令补全；本地命令校验参数并提供复制结果反馈。

## 0.2.46 — 2026-09-12

- 模型选择器右侧改为仅模型列表区域滚动，标题与搜索框固定，滚动条从搜索框下方开始。

## 0.2.45 — 2026-09-12

- 模型选择器的“显示全部”视图按供应方分组，并在每组模型前展示供应方名称；搜索结果保留对应分组标题。

## 0.2.44 — 2026-09-12

- 思考级别菜单按当前模型的 `reasoning` 与 `thinkingLevelMap` 过滤，不再展示模型不支持的级别；后端同时拒绝越权级别。
- 修复模型选择器每次重绘都跳回当前供应方，供应方筛选现可正常切换并保持到本次选择器关闭。

## 0.2.43 — 2026-09-12

- 移除输入框模型与思考级别按钮前的 SVG 图标，仅保留可点击文本。

## 0.2.42 — 2026-09-12

- `#composer` 顶部 padding 略微增加，同时保留更紧凑的左右和底部间距。
- `#prompt` 默认恰好显示 2 行，随输入自动增高至最多 10 行；达到 10 行或会话区可用高度后改为内部滚动。

## 0.2.41 — 2026-09-12

- `#composer` 四周 padding 进一步收紧为桌面 `8px 12px`、移动端 `7px 9px`。
- `#prompt` 最小高度由桌面 90px 降至 78px、移动端由 72px 降至 64px，使输入区更紧凑。

## 0.2.40 — 2026-09-12

- `.compose-actions` 最小高度由 42px 收紧为 34px，与 32px 发送按钮匹配。
- `#composer` 上下 padding 改为相同的 10px，移动端为相同的 9px；`#prompt` 移除上下 padding。

## 0.2.39 — 2026-09-12

- 默认字体栈恢复为 `Noto Sans Mono`、`JetBrains Mono`、`Fira Code`、`Consolas`、`ui-monospace`、`Microsoft YaHei`、`monospace`，页面和 xterm 保持一致。
- 移除 MiSans 的页面样式、字体路由、测试覆盖与 npm 依赖；继续保留本地内嵌的 Noto Sans Mono。

## 0.2.38 — 2026-09-12

- 底部状态栏按钮、文字和 SVG 统一使用 14px 行盒与 24px 按钮高度，并通过 flex 完整垂直居中。
- SVG 改为 block 布局并移除基线偏移，修复图标与中英文、数字上下不齐。

## 0.2.37 — 2026-09-12

- MiSans 内嵌字重收敛为 Light 与 Semibold，移除 Medium、Bold 的页面引用和静态路由。
- 将 Light 字形映射到 CSS 400、Semibold 字形映射到 CSS 600，使普通正文和强调文本分别稳定使用这两套实际字形。

## 0.2.36 — 2026-09-12

- 补充本地 MiSans Semibold 中文分片，改善 Noto Sans Mono 英文与 MiSans 中文混排时的中等粗体匹配。
- 会话信息卡标题字重由 600 调整为 MiSans 原生 520 Semibold，降低标题与正文之间突兀的粗细差异。
- 发送按钮进一步缩小为 32px，使用 grid 精确居中 15px SVG；hover/active 保持强调色并仅调整明度，避免通用浅灰 hover 覆盖。

## 0.2.35 — 2026-09-12

- 圆形发送按钮由 42px 缩小为 36px，内部箭头同步缩小为 16px；停止按钮也按比例收紧。
- 底部 Token 输入/输出指标改用独立且完全对称的上、下箭头 SVG，统一路径长度、14px 画布与描边粗细。

## 0.2.34 — 2026-09-12

- 将 `.compose-wrap` 底部 padding 改为 0，移除 dock 外层的额外底部留白。
- `.status-shell` 改用上下各 6px 的对称间距，状态栏自身不再叠加垂直 padding。

## 0.2.33 — 2026-09-12

- 默认字体栈调整为 `Noto Sans Mono`、`JetBrains Mono`、`Fira Code`、`MiSans`、`monospace`，页面和 xterm 同步使用。
- 内嵌 MiSans 4.1.0 的 Medium/Bold 中文分片 WOFF2 与本地 CSS；字体按实际字符按需加载，不访问外部 CDN。
- Web 静态服务增加受文件名白名单约束的 MiSans 字体路由，并补充 CSS 与 WOFF2 集成验证。

## 0.2.32 — 2026-09-12

- 输入框右侧模型名称改为可点击的可视化选择器：左栏选择供应方，右栏筛选并选择模型，模型来自当前会话的 scoped models 或可用模型注册表。
- 思考级别恢复为模型按钮右侧的独立可点击选项，支持 off、minimal、low、medium、high、xhigh、max，并通过 pi 原生接口切换。
- 已选择模型时默认定位其供应方、模型与当前思考级别；未选择模型时仅在可用列表只有一个供应方的情况下自动选中该供应方，多个供应方则保持“显示全部”。
- 模型或思考级别仅能在空闲时切换；后端重新校验提交项是否属于当前可用列表。

## 0.2.31 — 2026-09-12

- 底部状态栏第一项改为当前会话标题；未设置标题时统一显示“未命名会话”。
- 第一项弹层从工作区详情改为“会话信息”，展示会话 ID、文件路径、所属工作区及路径、活跃时间、创建时间和活跃时长。

## 0.2.30 — 2026-09-12

- 收紧输入框与底部状态栏之间及状态栏下方的留白，统一为紧凑且对称的垂直间距。
- 状态栏改为只更新既有文本节点，不再随每秒统计刷新重建按钮 DOM，修复鼠标悬停背景反复闪烁。

## 0.2.29 — 2026-09-12

- 移除输入框左下角的附件占位和发送模式控件，Web 发送继续使用默认追加模式；右侧将模型与思考等级合并为无图标的 `模型 · 等级` 文本。
- 底部工作区状态去掉会话短 ID；所有状态 SVG 使用统一的 14px 画布尺寸、描边和按钮高度，使视觉重量更均衡。
- 收窄状态信息卡的内部点击范围：点击触发按钮或卡片以外的任意位置，包括状态栏空白区域，都会关闭卡片。

## 0.2.28 — 2026-09-12

- 默认字体栈精简为 `Noto Sans Mono`、`JetBrains Mono`、`Fira Code`，最后以通用 `monospace` 兜底；xterm 终端同步使用相同顺序。
- 新增本地内嵌的 Noto Sans Mono 可变字体资源，覆盖 Latin、Latin Extended、Vietnamese、Greek 与 Cyrillic 字符集，由 Web 服务直接提供，不依赖外部 CDN 或系统字体。

## 0.2.27 — 2026-09-12

- 输入框、状态栏、信息卡、导航及相关操作按钮改用统一的内联 SVG 图标，避免字体字形随平台变化。
- 状态详情卡和会话详情卡支持点击卡片外任意位置关闭，二者打开时互斥。
- 左下角改为会话信息按钮；弹层按会话 ID、会话文件路径、所在工作区、工作区路径、活跃时间、创建时间、活跃时长的顺序完整展示，并为各项可复制值提供 SVG 复制按钮。

## 0.2.26 — 2026-09-12

- 参考目标界面重做底部输入框：扩大圆角输入区域，使用简洁 placeholder，左侧显示附件占位与发送模式，右侧显示运行状态、当前模型、思考等级、停止和圆形发送按钮。
- 输入框下方新增紧凑状态栏，展示工作区、对话轮数/轨迹事件、估算输出速度、输入/输出/总 Token、缓存命中率和成本。
- 状态栏分组支持点击弹出详情；工作区名称/ID/路径和各 Token/成本数据支持复制。统计值直接从当前分支 message、tool result、compaction 与 branch summary 的 usage 汇总。
- 修复 Web `/reload` 自动刷新竞态：在发送请求前持久化旧 `instanceId`，连接到不同的新实例后清除标记并刷新一次；网络因重载中断时保留标记，防止错过刷新。

## 0.2.25 — 2026-09-12

- Markdown 围栏代码块增加 highlight.js 语法高亮，未指定或无法识别语言时自动检测。
- 代码块增加语言、总行数、逐行行号和复制按钮；行号使用独立 gutter，不会混入复制内容。
- 代码正文保持原始换行且不自动折行，长行横向滚动；增加适配明暗主题的语法颜色。
- 工具调用 Input 改用同一代码块组件并固定为 JSON 语言，保留格式化缩进、高亮、行号、行数和复制能力。
- 补充 Markdown 标题、引用、分隔线及列表间距样式；highlight.js 作为本地静态依赖提供，不加载 CDN。

## 0.2.24 — 2026-09-12

- 输入框改为固定在右侧内容区底部的浮动 dock；问卷与通用扩展请求固定显示在输入框上方。
- 消息区域恢复为工具栏下方的完整高度滚动区，滚动条不再因输入区占位而提前结束。
- 使用 `ResizeObserver` 测量浮动 dock 的实际高度并动态增加消息底部留白，保证最后一条消息可滚动到请求区和输入框上方，不被遮挡。
- 长问卷由卡片内容区滚动，长通用扩展请求由请求面板滚动，浮动输入区保持可见。

## 0.2.23 — 2026-09-12

- 修正 0.2.22 把浏览器根页面设为滚动容器造成顶部标题栏、侧栏和对话工具栏一起滚走的问题。
- 恢复固定的顶部标题栏、侧栏和对话工具栏，仅让右侧工具栏下方区域使用一条完整高度的纵向滚动条。
- 将消息、问卷、通用扩展请求和输入框共同放入该内容滚动区，保持同一居中列，并让短会话的输入框位于可视区域底部。

## 0.2.22 — 2026-09-12

- 取消对话区域自身的纵向滚动，将浏览器页面设为唯一纵向滚动容器，滚动条覆盖页面完整高度。
- 对话、输入框、ask_user_question 问卷和通用扩展请求统一进入同宽的居中内容流；移除请求面板和问卷内容区的高度限制及内层纵向滚动。
- “最新消息”和新消息自动跟随改为操作页面滚动位置。
- Web 输入 `/reload` 后记录当前扩展实例；新实例恢复 SSE 连接时自动刷新当前浏览器页面一次，确保静态页面和重载后的后端同步更新。

## 0.2.21 — 2026-09-12

- Thinking 块右侧增加与工具块一致的耗时显示：折叠精确到秒，展开增加毫秒，思考进行时实时更新。
- 流式思考默认展开，思考完成后自动折叠。
- 用户在思考期间手动折叠或展开后记录该选择，完成时不再自动折叠，并在后续流式重绘中保持用户选择。

## 0.2.20 — 2026-09-12

- 工具块右侧由状态文字改为实际执行耗时；状态继续通过运行中、成功、失败三种颜色表达。
- 折叠状态显示到秒，展开状态增加毫秒；运行中的耗时由页面实时更新，完成后固定为最终耗时。
- 后端按 `toolCallId` 记录本次进程内工具执行的开始与结束时间，并随 Web 快照同步。

## 0.2.19 — 2026-09-12

- 工具调用标题中的工具名与关键参数改为当前生命周期状态色。
- Input JSON 保留格式且禁止自动换行，超出可用宽度时改用横向滚动；Output 保留原有换行行为。

## 0.2.18 — 2026-09-12

- 工具调用折叠箭头改回原生 `details/summary` 标记，与 Thinking 块保持一致。
- 为 Markdown、纯文本及结构化工具输出增加统一的 Output 外框。
- 工具标题、参数、Input/Output 标签与正文统一继承项目默认字体。

## 0.2.17 — 2026-09-12

- 按 `toolCallId` 将工具调用输入和工具结果合并到同一张生命周期卡片，结果不再另起一块重复展示。
- 工具标题改为加粗工具名加关键输入参数，例如 **bash** `echo "thinking..."`；展开后以 Input/Output 分区展示完整内容。
- 运行中、执行成功和执行失败分别使用琥珀、绿色和红色的边框、标题及浅色背景；运行时更新保留起始事件的输入参数。

## 0.2.16 — 2026-09-12

- 思考块增加固定加粗 `Thinking` 前缀，与 pi 的 thinking 术语保持一致。
- 折叠摘要忽略原文换行并把全部连续空白压成单个空格，以浏览器实际像素宽度限制为一行。
- 仅在一行无法完整显示时通过宽度测量截断，并在末尾追加三个半角点 `...`；窗口尺寸变化时重新计算。
- 展开状态显示原始完整 Markdown 和换行，不再按内容首行拆分。

## 0.2.15 — 2026-09-12

- 思考块背景改为页面背景色，保留现有边框。
- 移除固定“思考过程”标题，改用思考文本第一行作为顶部折叠栏。
- 折叠时只显示第一行并追加 `...`；展开时显示第一行与其余完整内容，避免重复首行。

## 0.2.14 — 2026-09-12

- 移除用户消息气泡内的“你”标签；命令气泡简化为“命令”。
- 历史消息与实时生成/工具状态分区渲染，流式更新不再反复解析并替换整段历史对话，改善长会话卡顿。
- 修复把 Node HTTP `write()` 返回 false（背压）误判为客户端断开、从 SSE 客户端集合移除的问题。
- 后端事件合并刷新间隔从 60ms 降至 32ms，提高流式同步及时性。

## 0.2.13 — 2026-09-12

- 用户消息与命令消息改为右对齐的内容自适应气泡；短内容按文本宽度收缩，长内容达到上限后自动换行。
- 保留原有用户消息配色，桌面端最大宽度 80%/720px，窄屏最大宽度 92%。

## 0.2.12 — 2026-09-12

- 全项目默认字体改为 `Noto Sans Mono` → `Noto Sans Mono Fallback` → `JetBrains Mono` → `Fira Code` → `Consolas` → `ui-monospace` → `PingFang SC` → `Microsoft YaHei` → `monospace`。
- 状态信息、代码、命令列表、通知、扩展请求及 xterm 终端统一使用同一字体栈。

## 0.2.11 — 2026-09-12

- 问卷顶栏不再使用固定“请你确认”，改为显示 ask_user_question 原始 `question.header`，单题也保留 TUI 中的短标题。
- 题号与单选/多选类型作为次要信息显示；核对页顶栏显示“核对答案”。

## 0.2.10 — 2026-09-12

- 将带预览选项的选择区与预览区合并为一个统一外框，修复选中时边框断裂、重叠和背景只覆盖上半部分的问题。
- 按选项记录 preview 的展开/折叠状态；选择选项或其他表单重绘后保持各预览原状态。

## 0.2.9 — 2026-09-12

- 多选题的自由回答改为可与普通复选项同时选中；聚焦或输入仅勾选自由回答，不再清除其他选择。
- 多选提交时把非空自由文本作为额外 selected 项，与普通选项一起交给 ask_user_question；取消勾选自由回答不影响普通选项。
- “清除选择”同步清空普通选项、自由回答勾选和文本，保留备注。

## 0.2.8 — 2026-09-12

- 压缩单选预览折叠条的高度：移除通用 details 的大间距，缩小内边距、字号和行高，并紧贴对应选项卡。
- 预览展开时才增加正文间距，折叠状态减少垂直空间占用。

## 0.2.7 — 2026-09-12

- 修复多选题的自由回答仍显示为圆形 radio；现在随题型使用方形 checkbox，单选题继续使用 radio。
- 自由回答仍遵循 ask_user_question 原协议：选择后替代并清除上方普通选项。

## 0.2.6 — 2026-09-12

- ask_user_question 删除自由回答卡片内重复的“自行填写”标题，仅保留单选框与输入框。
- “清除选择”和“取消问卷”移到底部操作栏，与上一题、下一题及提交按钮集中排列。
- 整体缩小问卷标题、选项、描述、输入框和按钮字号，并压缩卡片内边距与间距。

## 0.2.5 — 2026-09-12

- 修复 ask_user_question 点击按钮、切换页签或选择选项时，表单重建导致问卷内容滚动条跳回顶部。
- 重建前后同时保留页面、对话区、扩展请求区和问卷内容区的滚动位置，并在浏览器布局完成后再次校正。

## 0.2.4 — 2026-09-12

- 修复 Web `/reload` 在消息事件更新后误用普通事件上下文、调用不存在的 `reload()` 并导致 pi 进程退出。
- 改由隐藏的内部扩展命令取得 pi 提供的命令上下文后执行重载；异常会被捕获并显示，不再形成未处理异常。

## 0.2.3 — 2026-09-12

- ask_user_question 的自由回答说明和备注标题移入对应输入框 placeholder，减少重复标签。
- 专用问卷随内容自然增高，最大高度扩展到对话区域可用高度；超过后仅问卷内容区滚动，页头和操作栏保持可见。

## 0.2.2 — 2026-09-12

- Web UI 新增 `/reload`：调用宿主 TUI 的原生重载能力，重载完成后自动恢复 `/web` 服务。
- 重载前后复用 loopback 端口与页面凭证，当前标签页会自动重连，无需复制新地址或重新打开浏览器。

## 0.2.1 — 2026-09-12

- ask_user_question 选项改为纵向排列。
- “自行填写”改为与普通选项一致的末尾选项卡，卡内直接显示输入框；聚焦或输入自动选择该项并取消普通选项。

## 0.2.0 — 2026-09-12

- 专用问卷改用紧凑独立卡片，横排选项、按需填写与备注、固定操作栏，短问题无需滚动。

- 新增 ask_user_question 专用结构化适配，覆盖 1–4 题、单/多选、多行自由回答、备注、单选 Markdown 预览、核对/部分提交、取消、收起和草稿恢复。
- 使用工具原始参数与公开事件匹配，将验证后的 QuestionnaireResult 交给原回调，由原扩展生成最终工具结果；实测本机扩展 2.6.2。
- 移除菜单文字启发式识别；标准扩展请求保留通用桥接，未知 custom 保留终端兜底。

## 0.1.7 — 2026-09-12

- 修复多选 custom 请求退回终端：识别复选标记与 Submit 行，使用原生复选框并同步原组件。

## 0.1.6 — 2026-09-12

- custom 编号单选菜单优先展示原生单选框和确认按钮，保留选项说明；确认校验菜单并回填 TUI，非明确菜单保留终端兜底。

## 0.1.5 — 2026-09-12

- custom 请求改为可聚焦的 xterm.js 终端面板，保留 ANSI SGR 样式并按实际列宽缩放，修复长横线折行。
- 支持完整终端键盘输入、中文及粘贴；输入按序转发，动态更新保持焦点；过滤非样式终端控制。

## 0.1.4 — 2026-09-12

- 调整扩展请求面板到输入框正上方，与输入框同宽；仅面板外层滚动，移除选项列表与 pre 的嵌套滚动条。

- 新增通用扩展请求展示：select/confirm/input 双端响应，custom 渲染文本与键盘转发，editor 明确提示在 TUI 完成。
- 支持收起、取消、重连恢复待处理请求、会话校验与过期响应拒绝；无需逐扩展适配。

## 0.1.3 — 2026-09-12

- 修复斜杠命令执行后网页没有输入与输出：增加命令展示记录，镜像 `ctx.ui.notify` 文本（如 `/wj-status`），保留 TUI 通知。
- 展示记录按会话/分支隔离、内存限量保存；关闭服务恢复通知接口，连接凭证不进入记录。

## 0.1.2 — 2026-09-12

- 修复 `/reload` 后命令列表仍缺失：后端入口与服务改为 `.ts`，避开 pi 加载器的原生 ESM `.js` 缓存；已用真实加载器复现旧入口问题并验证 TS 更新生效。

## 0.1.1 — 2026-09-12

- 修复新版网页连接未重载的旧扩展时，将命令列表缺失误显示为“没有匹配命令”；改为提示重载扩展并打开新地址。

- 新增输入 `/` 的命令提示、前缀筛选、键盘与鼠标补全。
- 支持执行当前 pi 的扩展命令、提示词模板和技能命令（含参数）；未知命令明确报错。
- 内置终端命令与命令交互弹窗仍由 TUI 处理。

## 0.1.0 — 2026-09-12

- 新增 `/web`，在宿主 pi TUI 进程内启动当前会话 Web UI。
- 新增消息流、思考与工具输出、轨迹视图、追加/引导/停止操作、明暗主题与重连。
- 新增会话切换同步和旧会话操作保护、loopback 鉴权、退出清理。
- 当前仅桥接结构化消息；自定义 TUI UI 与命令交互保留在终端。
