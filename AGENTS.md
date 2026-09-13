# pi-atom-web 项目约定

- 前端已采用 Vue 3 runtime + Pinia + Vue Router memory history，入口为 `web/main.js`；普通 JS `h()`/Composition API 组件位于 `web/components/`，禁止恢复单体 DOM 渲染、SFC、构建工具或外部 CDN。`web/icons.js` 提供统一 SVG VNode，`web/clipboard.js` 提供统一安全复制。
- `shared/protocol.js` 同时供扩展和浏览器校验；快照与事件使用 `schemaVersion:1`，事件包含 `streamId/sequence/sessionId`。首次/切会发送 snapshot，其余发送 patch；live-only 更新不得遍历、复制或发送历史。历史 ID 取 branch entry ID，完成消息的 `liveId` 用于迁移 Thinking 手动状态与计时。
- `web/api/` 负责单连接、鉴权、序号检查和取消；`web/stores/` 分离 session/conversation/composer/dialogs。组件拥有 DOM、观察器、计时器与终端实例，卸载必须清理。
- 验证包含 `npm run check`、`npm test`、独立 `npm run test:browser`；check 递归检查源文件，Node 测试与浏览器测试分开，禁止零测试假成功。浏览器测试使用内存 fixture 与本地服务器，不调用真实模型或写真实会话。

- `.agents/skills/`：Codex 项目级技能目录，当前包含 `pi-vue-nobuild`、`frontend-design`、`vue-best-practices`、`pinia`、`vue-router-best-practices`、`node`、`web-design-guidelines`、`accessibility-compliance`、`responsive-design`、`interaction-design`。这些技能供 Codex 在本项目中自动发现；不得放入供 pi agent 使用的 `.pi/skills/`。其中 `pi-vue-nobuild` 是本项目架构约束，优先于通用 Vue 技能中关于 SFC、构建工具或外部 CDN 的建议。
- 产品：pi-atom 系列的当前 TUI 会话 Web 扩展，命令 `/web`；严格一对一绑定宿主进程当前会话。
- 不创建独立 agent、项目管理或会话管理系统。使用扩展 API 收发消息与订阅事件。
- `extensions/index.ts`：入口、`/web` 与 `/web stop`、消息桥接、生命周期；通过 `pi.getCommands()` 提供命令列表，并补充 Web 命令 `/reload`、`/model`、`/session`、`/copy`、`/name`、`/compact`。`/reload` 分发到隐藏内部命令 `pi-atom-web-reload`，只在命令 handler 收到的 `ExtensionCommandContext` 上调用 `reload()`；严禁在会被事件替换的普通 `ExtensionContext` 上调用。`/model`、`/session`、`/copy` 在浏览器本地复用现有 UI；`/name` 使用 `pi.setSessionName()`；`/compact` 使用 `context.compact()`。进程内 handoff 复用端口/凭证并在新实例的 `session_start` 恢复服务。其余已知命令使用 `expandPromptTemplates: true` 分发，未知命令不得误发模型。
- `extensions/server.ts`：仅 loopback HTTP 服务、随机凭证、Host/Origin 校验、SSE、静态资源；仅 `/reload` 进程内交接可指定旧端口与凭证。
- `web/`：页面、样式、浏览器交互（含 `/` 前缀筛选、键盘/点击补全）；Markdown 必须清洗；不能把不可信内容直接作为 HTML。
- Markdown 围栏代码统一由 `codeBlock()` 渲染：highlight.js 高亮、语言、总行数、独立行号 gutter 和复制按钮；正文及行号不得自动换行，复制只能读取 `.code-source code`，不能包含 gutter。工具 Input 必须复用该组件并显式使用 JSON。行内代码必须由 `.body :not(pre)>code` 提供与代码块同一套设计语言的标记：`--panel` 底、`--border` 描边、5px 圆角、`1px 5px` 内边距、`overflow-wrap:anywhere` 与 `box-decoration-break:clone`（全站基础字体已是等宽字体栈，只靠字体无法与正文区分）；围栏代码块内的 `code` 不得再套这层外框。highlight.js 使用 `@highlightjs/cdn-assets` 的本地浏览器构建，由 server.ts 暴露，禁止连接外部 CDN。
- 全页面及 xterm 统一使用 `--font-mono` 对应的字体栈：Noto Sans Mono、JetBrains Mono、Fira Code、Consolas、ui-monospace、Microsoft YaHei、monospace；局部组件不得覆盖成其他字体栈。Noto Sans Mono 使用 `@fontsource-variable/noto-sans-mono` 的本地 WOFF2，由 `web/fonts.css` 声明、`server.ts` 提供；禁止连接外部字体服务。
- 用户消息与命令消息使用 `.message.user` 右对齐内容自适应气泡；保持 `--user` 配色，短内容收缩，长内容受最大宽度限制后换行。用户气泡与助手消息都不显示角色标签，命令气泡仅显示“命令”，分支/上下文摘要显示各自的摘要标签。
- 浏览器消息区分为 `#message-history` 与 `#message-live`；流式消息/工具更新只能替换 live 区，历史内容变化时才更新 history 区，禁止每个增量重建完整 transcript。顶层条目（消息、孤儿工具卡、通知、自定义 Entry）与消息内部必须使用同一个 8px 间距：`#message-history>*{margin-bottom:8px}`、`.message{margin:0 0 8px}`，消息内 `.body details{margin:8px 0}` 与之一致；不得再写回全局 `details{margin:10px 0}`，也不得再出现 10px / 27px 之类的第二套节奏。
- 历史按“轮”折叠中间过程：一段连续的 assistant/toolResult 消息构成一轮的分组（`TurnGroup` + `turnGroups.js`），标题按固定顺序拼接「x 次思考过程 · y 次工具调用 · z 次技能调用 · a 条消息」（a = 折叠区内的正文段落数），数量为 0 的分段省略，没有任何中间过程时完全不渲染标题。本轮最后一条不含工具调用的 assistant 消息里，从最后一个非空正文块开始的部分是最终输出，留在折叠块之外；其余（含该消息里更早的思考）进折叠块，且折叠区里保留原下标以保证 Thinking 的稳定 identifier 不变。折叠块复用现有消息与工具卡渲染，自身去掉卡片外框：标题行左上角是原生 details 三角（收起/展开自动切换），标题下有一条分割线；不提供右侧 chevron、左侧灰线与子级缩进，正文与标题左对齐。仍在输出的一轮默认展开，整轮输出完全停止后才自动收起（以会话 `busy` 为准：工具执行中、消息间隙都不折叠），用户手动操作过则始终以记录状态为准；折叠区沿用页面正文排版（`.turn-group{font-size:inherit}` 覆盖通用 `details` 的 12px），因此中间消息与最终输出样式完全一致；用户、命令、通知、自定义 Entry、分支/上下文摘要与终端输出各自独立渲染并切断分组；执行轨迹视图不做按轮折叠。
- Web 提交普通 prompt 时，浏览器必须在同一交互帧插入临时用户消息，明确的 action 失败立即撤销；后端同时发布内存临时消息，真实 branch 用户消息到达后按会话、锚点、内容和提交顺序无重复替换。不得用固定超时把尚未出现 `message_start` 的正常慢 preflight 误判为失败。提示词模板与技能命令复用同一轮次等待绑定，但继续显示为命令记录。等待模型响应超过 1 秒才显示 `正在等待模型响应... (Ns)`，assistant 首个 start/update、agent 结束、取消或会话切换时清除；发送失败的轮次结束时必须清理尚未入历史的临时消息。临时消息和等待状态不得写入会话或发送模型。
- 内容列宽度可由用户调整：hover `#messages` 左右边界时在鼠标高度显示细长手柄（`ColumnResizer`），拖动对称改变消息区、输入 dock 与状态栏共用的 `--content-width`，双击手柄恢复默认，键盘聚焦热区后 `←`/`→` 步进调整（`Shift` 加速）。手柄为 3px 细线、两端渐隐、圆头，拖动中改用强调色，不提供 hover 文字提示；热区宽 32px、只贴在文字区外侧以免遮挡文本选择，纵向从工具栏下沿一直延伸到视口底部，因此在输入框所在区域也能抓住边界；宽度上限按 `#scroll` 实际可用宽度（两侧各留 16px，滚动条出现时不溢出），下限 520px；宽度记忆在 `localStorage` 的 `atom-content-width`，宽度 ≤900px 的窄视口不提供手柄。拖动期间每个动画帧最多写一次宽度变量、读一次几何；内边距、滚动容器宽度、dock 顶边与手柄高度等环境读数只在挂载、尺寸变化与拖动结束时缓存，禁止每个 `pointermove` 触发多次强制同步布局。
- 禁止为历史条目开启 `content-visibility:auto`（含 `contain-intrinsic-size`）：被跳过的条目只渲染为“记住高度”的空白块，会在长会话里出现看不见的空白（用户实际遇到），且 scrollHeight 被估算值放大（实测 +11%～+63%）。该机制实测对拖动收益有限（真实内容 106ms/帧 → 关闭后 232ms/帧），不值得这些副作用。改变内容列宽度会重排可见区域的 transcript，优化方向应是减少每帧几何读取与拖动更新频率，而不是跳过屏外元素。
- `html/body` 禁止滚动；页面不渲染产品顶部标题栏和左侧会话栏，对话 `main` 占满整个视口，`.toolbar` 固定在顶部。`.toolbar` 下方的 `#scroll` 占满剩余高度并只承载消息滚动。`.compose-wrap` 是固定在 main 底部的浮动 dock，包含问卷/通用扩展请求和输入框；四者使用同一个居中列（宽度由 `--content-width` 控制，默认 860px）及一致水平 padding。输入框不展示附件占位或发送模式控件，Web 提交固定使用 followUp；右侧仅以 `模型 · 思考等级` 文本显示状态。用 `ResizeObserver` 把 dock 实际高度写入 `--compose-height`，`#messages` 底部留白必须随之变化。`.compose-wrap` 在 `main` 内居中，而消息列在 `#scroll` 内容盒内居中，两者参照物不同：必须用 content-box 观察 `#scroll` 把滚动条宽度写入 `--scrollbar-width`，并让 dock 用 `left: calc(50% - var(--scrollbar-width,0px)/2)` 左移半个滚动条，否则长会话出现滚动条后输入框与状态栏会整体右移半个滚动条宽度（实测 7.5px）。长通用请求滚动 `#plugin-requests`，ask_user_question 保持页头/页脚固定并只滚动 `.ask-content`。仅当 `#scroll` 位于最底部时自动跟随消息；用户向上滚动任意距离后立即停止，重新到达底部后恢复。顶部不显示“最新消息”，离底时改在输入框上方居中显示圆形向下按钮；点击必须先同步恢复自动跟随，再在 DOM 更新和下一渲染帧校准到底部，避免流式 Thinking 增长超过一次性滚动。
- 输入框左侧图片按钮支持选择 PNG/JPEG/GIF/WebP，页面支持拖入图片且输入框支持粘贴图片，提交前显示可移除缩略图；最多 4 张、单张 8 MiB、合计 16 MiB，图片与可选文本作为同一条用户消息通过 `pi.sendUserMessage()` 发送。附件只在当前浏览器内存中保留至发送或移除，不写入 Web 派生状态。
- 含图片的用户消息使用右对齐附件条：图片以 80px 方形缩略图横向排列在文字气泡上方，文字继续使用独立的 `--user` 自适应气泡；纯图片消息不生成空文字气泡。
- 输入框附件和会话中的图片必须复用 `PreviewImage`：点击缩略图通过 Teleport 打开全屏等比例预览，提供 SVG 关闭按钮，并支持点击遮罩和 `Esc` 关闭；关闭后焦点返回原缩略图。
- thinking 内容使用 `.thinking-block` 专用 details：背景必须为 `--bg`，summary 以固定加粗 `Thinking` 开头；折叠摘要把 `\\s+` 压成单个空格，并以 DOM 实际 `clientWidth/scrollWidth` 二分截断为一个视觉行，仅溢出时追加三个半角点 `...`，resize 后重算；展开时隐藏摘要文本并按原始 Markdown/换行显示全文。流式 thinking 默认展开并计时，完成后默认折叠；思考计时以“同一轮内思考块之后是否已出现正文或工具调用块”为结束界，后续输出时间不得计入，只有位于消息末尾、仍在生成的思考块继续计时并在整轮结束时结算；折叠耗时到秒且不足一秒显示 `<1s`、展开耗时到毫秒，耗时始终相对 summary 标题行垂直居中。以稳定消息标识记录用户在运行期间的手动 toggle，一旦操作过，后续流式重绘和完成转换必须保留用户最后状态，不得自动折叠。
- 工具调用按 `toolCallId` 合并 assistant 的 `toolCall` 输入和 `toolResult` 输出；运行中事件在同一卡片显示，并合并 update 与 start 以保留输入参数。标题使用状态色显示加粗工具名与关键参数，正文分 Input/Output 且二者均有统一外框；Input JSON 必须保持 `white-space: pre`，禁止自动换行并允许横向滚动，Output 保持可换行。运行中、成功、失败使用不同状态色；右侧垂直居中显示执行耗时，折叠到秒且不足一秒显示 `<1s`，展开到毫秒，运行时由浏览器计时、完成后使用后端记录的最终值。折叠箭头沿用与 Thinking 相同的原生 summary 标记，工具块全部继承项目默认字体。读取 `SKILL.md` 的 `read` 调用按技能卡展示，判定必须与 pi 宿主一致（`dist/core/tools/renderers/read.js` 的 `getCompactReadClassification`）：仅 `read` 工具、路径 basename 为 `SKILL.md`、大小写敏感、`file_path` 优先于 `path`；折叠标题显示 `skill` 与技能目录名，整卡用 `--tool-skill` 覆盖状态色（失败状态仍保留在 class 上，仅颜色被覆盖）。
- Thinking、工具调用、TUI 通知及自定义 Entry 必须复用 `DisclosureBlock` 的统一 `details/summary` 折叠结构；各业务组件只负责标题、状态、计时及正文。所有折叠摘要必须把连续空白和换行压成单个空格，只占一个视觉行并在溢出时显示省略号。折叠行必须保持紧凑：`summary{line-height:1.45}`，卡片摘要内边距 `7px 12px`，通用 `details{padding:7px 12px}`（Thinking 与 markdown 折叠块共用同一条），折叠态卡片实测约 33px 高；不得改回 9–10px 内边距或 1.6 行高。
- Pi branch 中所有 `type: "custom"` Entry 均须通用转发为 `customEntry`，不得按插件名特判；后端观察 Pi `ExtensionRunner.getEntryRenderer()` 得到实际注册的 TUI renderer，分别生成折叠态与展开态文本、清除 ANSI 控制码，并对 `customType`、`data` 和时间戳做有界 JSON 归一化。Web 通用卡片优先展示 renderer 文本，展开正文使用与 TUI 通知相同的默认字体，原始 JSON 收入二级折叠区；renderer 缺失或失败时，对象数据以 `[JSON OBJECT]` 为摘要并用 JSON 代码块展示，其他值按纯文本展示。浏览器不得执行 TUI 组件、插件 HTML 或其他不可信代码。
- `extensions/tool-events.ts` 只向 Web 协议暴露工具卡需要的字段，并将扩展自定义的 `args`、`partialResult` 转为有界 JSON；循环引用、`BigInt`、异常 getter 或私有句柄不得导致 SSE 断开。单条 SSE 事件无法编码时不得销毁连接或消耗序号。
- Node HTTP `response.write()` 返回 false 仅表示背压，数据已经接收，禁止据此删除或销毁 SSE 客户端；仅写入抛错或连接 close 时清理。
- SSE 协议必须校验 JSON 序列化后的实际传输形态；Pi 内存对象允许存在会被 JSON 忽略的 `undefined` 可选字段，不得因此拒绝整个快照或增量。
- 每次扩展加载生成新的 `instanceId` 并放入快照；Web `/reload` 保存旧实例 ID，SSE 连到不同实例后清除标记并执行一次 `location.reload()`，不得在旧实例仍存活时提前刷新或形成刷新循环。
- Web `/reload` 的旧 `instanceId` 必须在 POST 发出前写入 sessionStorage，避免新实例在响应返回前恢复而错过刷新；仅明确的命令错误清除标记，重载导致的 fetch 网络中断须保留标记等待新 SSE。
- `sessionStats()` 从当前 branch 汇总轮数、事件数及 message/toolResult/compaction/branch_summary usage，向输入框下方状态栏提供真实工作区、Token、缓存命中率与成本；输出速度标记为按会话活跃时长估算。状态分组点击显示详情，复制使用与代码块相同的安全剪贴板回退。
- 状态栏每秒刷新时只能更新已有的 `[data-status-value]` 文本节点，不得重建按钮 DOM，否则会中断 hover/focus。`.compose-wrap` 底部 padding 固定为 0，状态栏与输入框、dock 底边的对称垂直间距统一由 `.status-shell` 提供。
- 状态栏按钮固定使用 24px 高度，文字与 SVG 使用相同的 14px 行盒；按钮和文字用 flex 垂直居中，SVG 用 block 且不得保留基线偏移。
- 状态栏第一项显示 `pi.getSessionName()` 返回的会话标题，空标题统一显示“未命名会话”；点击后展示与左下角一致的“会话信息”，不得退回工作区摘要卡。
- 输入框右侧模型与思考级别均为无前置图标的独立可点击文本设置。模型清单优先使用 `context.scopedModels`，未设 scope 时使用 `context.modelRegistry.getAvailable()`；提交后必须按 provider+id 从当前列表重新定位模型，再调用 `pi.setModel()`。有当前模型时默认选中其供应方与模型；无当前模型时仅单供应方自动选中，多个供应方不得自动选。思考菜单默认选中 `context.thinkingLevel`，并按当前模型的 `reasoning` 与 `thinkingLevelMap` 仅展示受支持级别，通过 `pi.setThinkingLevel()` 更新且后端重复校验；供应方筛选在选择器打开期间保持用户选择，不得被状态重绘重置；“显示全部”按供应方分组并在各组前展示供应方名称；右侧标题与搜索框固定，仅其下方模型列表滚动。生成期间禁止切换二者。
- `#composer` 使用顶部略宽、其余方向紧凑的内边距：桌面端 `10px 12px 8px`、移动端 `9px 9px 7px`；`#prompt` 不得设置上下 padding，默认显示 2 行并随输入自动增高，最多显示 10 行且不得超过会话区可用高度；`.compose-actions` 最小高度为 34px，与 32px 发送按钮匹配。
- Web UI 操作图标统一使用 `web/icons.js` 的内联 SVG 图标组件，不得使用 Unicode/字体图标模拟；底部状态栏图标使用相同尺寸、描边及按钮高度。状态详情与左下角会话详情弹层必须互斥，只有触发按钮和弹层自身属于内部点击区域，点击其余任意位置均关闭。底部工作区摘要不显示会话短 ID。会话详情不重复会话名，依次展示会话 ID、会话文件路径、所在工作区、所在工作区路径、活跃时间、创建时间和活跃时长；可复制字段使用 SVG 复制按钮。
- 底部 Token 输入/输出必须使用独立但几何对称的 `up`/`down` SVG，保持相同画布、路径长度和描边；不得复用圆形发送按钮的 `send` 图标。发送按钮使用 32px 圆形和 15px 图标，以 grid 居中；hover/active 保持 accent 色系，不得继承通用按钮的浅灰背景。
- `test/`：HTTP/SSE 与扩展桥接集成测试，禁止调用真实模型或写真实会话。
- Web 派生会话状态落盘到工作区 `.pi/atom/<sessionId>/web-state.json`，包括 Pi 会话文件不保存的 Thinking/工具最终耗时、用户折叠状态以及命令/通知镜像；同目录临时文件原子替换并限制为 500 项。连接凭证、临时 Prompt、运行中状态、滚动位置不落盘。跨项目设置预留 `~/.pi/atom/`，未有全局设置时不得创建。
- 修改扩展后同步更新本文件、README.md 和 CHANGELOG.md；文档使用中文。
- 验证：`npm run check`、`npm test`。依赖由 package-lock.json 固定。

- pi 扩展后端使用 `.ts` 文件：已复现当前加载器会缓存原生 ESM `.js`，即使重新加载仍调用旧工厂；不要改回 `.js`。浏览器继续使用 `shared/protocol.js`，后端必须使用内容同步的 `shared/protocol.ts`，避免 `/reload` 后继续引用旧协议校验器。

- 命令输入与 `ctx.ui.notify` 是独立展示记录，按会话和分支锚点合并到网页消息，最多 500 条，落盘到项目级 Web 会话状态且不送模型。服务启动时包装共享 UI notify；`/reload` 的替换实例必须在 `session_start` 第一次异步操作前恢复包装，并将状态加载期间收到的通知合并落盘，停止/退出时恢复原方法。本扩展连接地址通知必须绕过镜像，防止凭证泄漏。

- `extensions/dialogs.ts`：按 UI 方法统一桥接 select/confirm/input/custom，不按扩展命令特判；editor 仅展示并提示 TUI 完成。请求 ID + 会话校验，双端首次完成生效，停止恢复原方法；custom 使用同一个组件，镜像 render 的 ANSI SGR 样式与列宽，使用本地 xterm.js 按比例缩放并转发 handleInput；输入按顺序发送，更新保留终端实例和焦点。禁用 OSC 等非样式控制，不引入内层滚动条。

- 扩展请求面板位于 `.compose-wrap` 内、输入框正上方，与输入框同宽；仅外层面板限制高度并滚动，选项列表和 pre 不再独立滚动。

- `extensions/ask-user.ts`：专门适配 @juicesharp/rpiv-ask-user-question 2.6.2；工具参数与公开事件双重匹配、QuestionnaireSession 工厂守卫，直接构造原 QuestionnaireResult，不解析终端文本、不模拟按键答题。
- `web/components/dialogs/AskUserForm.js`：1–4 题结构化表单，单选/多选/多行自由回答/备注/单选 Markdown 预览/核对与部分提交/取消/收起；草稿按请求存于标签页 sessionStorage，结束清理。两端未提交草稿独立，最终先完成者生效。
- 标准 UI 请求走通用桥；未知 custom 只使用终端兜底。已移除编号菜单启发式识别模块与相应测试。

- ask_user_question 使用紧凑独立卡片，选项垂直排列；自由回答是同款末尾选项卡，只显示随题型变化的选择框（单选 radio、多选 checkbox）与内嵌文本框，不显示重复标题。单选 focus/input 选择 custom 并清除普通选项；多选 focus/input 只设置 `kind:multi, custom:true`，保留 `options`，提交时非空 text 追加到 selected。自由回答说明与备注标题放入各自 placeholder。备注按需展开；清除与取消按钮放到底部操作栏右侧，和导航/提交集中排列；单题直接提交，多题保留核对。卡片随内容自然增高，最大为对话区域可用高度，内容过长仅内容区滚动，页头与操作栏不随其滚走。任何表单重建必须保存并恢复页面、对话、请求面板及 ask-content 的滚动位置，禁止交互后跳顶。
- 问卷顶栏必须显示当前问题的原始 `question.header`，包括单题问卷；题号/总数/题型作为 muted 次要信息，核对页显示“核对答案”，不得用固定文案覆盖 header。
- 单选 preview 的选择区与预览区使用 `.ask-option` 统一外框，选中边框/背景作用于整个组合，不允许上下块边框重叠或断裂。折叠条使用紧凑样式并紧贴对应选项；折叠时不继承通用 details 的大间距，展开后再为正文增加间距。展开项索引保存在问卷本地 `previews` Set，任何表单重建均须恢复。
