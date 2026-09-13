# pi-atom-web 项目约定

- `.agents/skills/`：Codex 项目级技能目录，当前包含 `pi-vue-nobuild`、`frontend-design`、`vue-best-practices`、`pinia`、`vue-router-best-practices`、`node`、`web-design-guidelines`、`accessibility-compliance`、`responsive-design`、`interaction-design`。这些技能供 Codex 在本项目中自动发现；不得放入供 pi agent 使用的 `.pi/skills/`。其中 `pi-vue-nobuild` 是本项目架构约束，优先于通用 Vue 技能中关于 SFC、构建工具或外部 CDN 的建议。
- 产品：pi-atom 系列的当前 TUI 会话 Web 扩展，命令 `/web`；严格一对一绑定宿主进程当前会话。
- 不创建独立 agent、项目管理或会话管理系统。使用扩展 API 收发消息与订阅事件。
- `extensions/index.ts`：入口、`/web` 与 `/web stop`、消息桥接、生命周期；通过 `pi.getCommands()` 提供命令列表，并补充 Web 命令 `/reload`、`/model`、`/session`、`/copy`、`/name`、`/compact`。`/reload` 分发到隐藏内部命令 `pi-atom-web-reload`，只在命令 handler 收到的 `ExtensionCommandContext` 上调用 `reload()`；严禁在会被事件替换的普通 `ExtensionContext` 上调用。`/model`、`/session`、`/copy` 在浏览器本地复用现有 UI；`/name` 使用 `pi.setSessionName()`；`/compact` 使用 `context.compact()`。进程内 handoff 复用端口/凭证并在新实例的 `session_start` 恢复服务。其余已知命令使用 `expandPromptTemplates: true` 分发，未知命令不得误发模型。
- `extensions/server.ts`：仅 loopback HTTP 服务、随机凭证、Host/Origin 校验、SSE、静态资源；仅 `/reload` 进程内交接可指定旧端口与凭证。
- `web/`：页面、样式、浏览器交互（含 `/` 前缀筛选、键盘/点击补全）；Markdown 必须清洗；不能把不可信内容直接作为 HTML。
- Markdown 围栏代码统一由 `codeBlock()` 渲染：highlight.js 高亮、语言、总行数、独立行号 gutter 和复制按钮；正文及行号不得自动换行，复制只能读取 `.code-source code`，不能包含 gutter。工具 Input 必须复用该组件并显式使用 JSON。highlight.js 使用 `@highlightjs/cdn-assets` 的本地浏览器构建，由 server.ts 暴露，禁止连接外部 CDN。
- 全页面及 xterm 统一使用 `--font-mono` 对应的字体栈：Noto Sans Mono、JetBrains Mono、Fira Code、Consolas、ui-monospace、Microsoft YaHei、monospace；局部组件不得覆盖成其他字体栈。Noto Sans Mono 使用 `@fontsource-variable/noto-sans-mono` 的本地 WOFF2，由 `web/fonts.css` 声明、`server.ts` 提供；禁止连接外部字体服务。
- 用户消息与命令消息使用 `.message.user` 右对齐内容自适应气泡；保持 `--user` 配色，短内容收缩，长内容受最大宽度限制后换行。用户气泡不显示“你”角色标签，命令气泡仅显示“命令”。
- 浏览器消息区分为 `#message-history` 与 `#message-live`；流式消息/工具更新只能替换 live 区，历史内容变化时才更新 history 区，禁止每个增量重建完整 transcript。
- `html/body` 禁止滚动，顶部标题栏、侧栏和 `.toolbar` 固定在视口布局中；`.toolbar` 下方的 `#scroll` 占满剩余高度并只承载消息滚动。`.compose-wrap` 是固定在 main 底部的浮动 dock，包含问卷/通用扩展请求和输入框；四者使用同一个 860px 居中列及一致水平 padding。输入框不展示附件占位或发送模式控件，Web 提交固定使用 followUp；右侧仅以 `模型 · 思考等级` 文本显示状态。用 `ResizeObserver` 把 dock 实际高度写入 `--compose-height`，`#messages` 底部留白必须随之变化。长通用请求滚动 `#plugin-requests`，ask_user_question 保持页头/页脚固定并只滚动 `.ask-content`。自动跟随与“最新消息”只操作 `#scroll`。
- thinking 内容使用 `.thinking-block` 专用 details：背景必须为 `--bg`，summary 以固定加粗 `Thinking` 开头；折叠摘要把 `\\s+` 压成单个空格，并以 DOM 实际 `clientWidth/scrollWidth` 二分截断为一个视觉行，仅溢出时追加三个半角点 `...`，resize 后重算；展开时隐藏摘要文本并按原始 Markdown/换行显示全文。流式 thinking 默认展开并计时，完成后默认折叠；折叠耗时到秒、展开耗时到毫秒，耗时始终相对 summary 标题行垂直居中。以稳定消息标识记录用户在运行期间的手动 toggle，一旦操作过，后续流式重绘和完成转换必须保留用户最后状态，不得自动折叠。
- 工具调用按 `toolCallId` 合并 assistant 的 `toolCall` 输入和 `toolResult` 输出；运行中事件在同一卡片显示，并合并 update 与 start 以保留输入参数。标题使用状态色显示加粗工具名与关键参数，正文分 Input/Output 且二者均有统一外框；Input JSON 必须保持 `white-space: pre`，禁止自动换行并允许横向滚动，Output 保持可换行。运行中、成功、失败使用不同状态色；右侧垂直居中显示执行耗时，折叠到秒、展开到毫秒，运行时由浏览器计时、完成后使用后端记录的最终值。折叠箭头沿用与 Thinking 相同的原生 summary 标记，工具块全部继承项目默认字体。
- Node HTTP `response.write()` 返回 false 仅表示背压，数据已经接收，禁止据此删除或销毁 SSE 客户端；仅写入抛错或连接 close 时清理。
- 每次扩展加载生成新的 `instanceId` 并放入快照；Web `/reload` 保存旧实例 ID，SSE 连到不同实例后清除标记并执行一次 `location.reload()`，不得在旧实例仍存活时提前刷新或形成刷新循环。
- Web `/reload` 的旧 `instanceId` 必须在 POST 发出前写入 sessionStorage，避免新实例在响应返回前恢复而错过刷新；仅明确的命令错误清除标记，重载导致的 fetch 网络中断须保留标记等待新 SSE。
- `sessionStats()` 从当前 branch 汇总轮数、事件数及 message/toolResult/compaction/branch_summary usage，向输入框下方状态栏提供真实工作区、Token、缓存命中率与成本；输出速度标记为按会话活跃时长估算。状态分组点击显示详情，复制使用与代码块相同的安全剪贴板回退。
- 状态栏每秒刷新时只能更新已有的 `[data-status-value]` 文本节点，不得重建按钮 DOM，否则会中断 hover/focus。`.compose-wrap` 底部 padding 固定为 0，状态栏与输入框、dock 底边的对称垂直间距统一由 `.status-shell` 提供。
- 状态栏按钮固定使用 24px 高度，文字与 SVG 使用相同的 14px 行盒；按钮和文字用 flex 垂直居中，SVG 用 block 且不得保留基线偏移。
- 状态栏第一项显示 `pi.getSessionName()` 返回的会话标题，空标题统一显示“未命名会话”；点击后展示与左下角一致的“会话信息”，不得退回工作区摘要卡。
- 输入框右侧模型与思考级别均为无前置图标的独立可点击文本设置。模型清单优先使用 `context.scopedModels`，未设 scope 时使用 `context.modelRegistry.getAvailable()`；提交后必须按 provider+id 从当前列表重新定位模型，再调用 `pi.setModel()`。有当前模型时默认选中其供应方与模型；无当前模型时仅单供应方自动选中，多个供应方不得自动选。思考菜单默认选中 `context.thinkingLevel`，并按当前模型的 `reasoning` 与 `thinkingLevelMap` 仅展示受支持级别，通过 `pi.setThinkingLevel()` 更新且后端重复校验；供应方筛选在选择器打开期间保持用户选择，不得被状态重绘重置；“显示全部”按供应方分组并在各组前展示供应方名称；右侧标题与搜索框固定，仅其下方模型列表滚动。生成期间禁止切换二者。
- `#composer` 使用顶部略宽、其余方向紧凑的内边距：桌面端 `10px 12px 8px`、移动端 `9px 9px 7px`；`#prompt` 不得设置上下 padding，默认显示 2 行并随输入自动增高，最多显示 10 行且不得超过会话区可用高度；`.compose-actions` 最小高度为 34px，与 32px 发送按钮匹配。
- Web UI 操作图标统一使用 `web/app.js` 的内联 SVG 图标组件，不得使用 Unicode/字体图标模拟；底部状态栏图标使用相同尺寸、描边及按钮高度。状态详情与左下角会话详情弹层必须互斥，只有触发按钮和弹层自身属于内部点击区域，点击其余任意位置均关闭。底部工作区摘要不显示会话短 ID。会话详情不重复会话名，依次展示会话 ID、会话文件路径、所在工作区、所在工作区路径、活跃时间、创建时间和活跃时长；可复制字段使用 SVG 复制按钮。
- 底部 Token 输入/输出必须使用独立但几何对称的 `up`/`down` SVG，保持相同画布、路径长度和描边；不得复用圆形发送按钮的 `send` 图标。发送按钮使用 32px 圆形和 15px 图标，以 grid 居中；hover/active 保持 accent 色系，不得继承通用按钮的浅灰背景。
- `test/`：HTTP/SSE 与扩展桥接集成测试，禁止调用真实模型或写真实会话。
- 无运行时磁盘数据；新增数据须遵守上级 AGENTS.md 的存储规范。
- 修改扩展后同步更新本文件、README.md 和 CHANGELOG.md；文档使用中文。
- 验证：`npm run check`、`npm test`。依赖由 package-lock.json 固定。

- pi 扩展后端使用 `.ts` 文件：已复现当前加载器会缓存原生 ESM `.js`，即使重新加载仍调用旧工厂；不要改回 `.js`。

- 命令输入与 `ctx.ui.notify` 是独立展示记录，按会话和分支锚点合并到网页消息，最多 500 条，不落盘、不送模型。服务启动时包装共享 UI notify，停止/退出时恢复；本扩展连接地址通知必须绕过镜像，防止凭证泄漏。

- `extensions/dialogs.ts`：按 UI 方法统一桥接 select/confirm/input/custom，不按扩展命令特判；editor 仅展示并提示 TUI 完成。请求 ID + 会话校验，双端首次完成生效，停止恢复原方法；custom 使用同一个组件，镜像 render 的 ANSI SGR 样式与列宽，使用本地 xterm.js 按比例缩放并转发 handleInput；输入按顺序发送，更新保留终端实例和焦点。禁用 OSC 等非样式控制，不引入内层滚动条。

- 扩展请求面板位于 `.compose-wrap` 内、输入框正上方，与输入框同宽；仅外层面板限制高度并滚动，选项列表和 pre 不再独立滚动。



- `extensions/ask-user.ts`：专门适配 @juicesharp/rpiv-ask-user-question 2.6.2；工具参数与公开事件双重匹配、QuestionnaireSession 工厂守卫，直接构造原 QuestionnaireResult，不解析终端文本、不模拟按键答题。
- `web/ask-user.js`：1–4 题结构化表单，单选/多选/多行自由回答/备注/单选 Markdown 预览/核对与部分提交/取消/收起；草稿按请求存于标签页 sessionStorage，结束清理。两端未提交草稿独立，最终先完成者生效。
- 标准 UI 请求走通用桥；未知 custom 只使用终端兜底。已移除编号菜单启发式识别模块与相应测试。

- ask_user_question 使用紧凑独立卡片，选项垂直排列；自由回答是同款末尾选项卡，只显示随题型变化的选择框（单选 radio、多选 checkbox）与内嵌文本框，不显示重复标题。单选 focus/input 选择 custom 并清除普通选项；多选 focus/input 只设置 `kind:multi, custom:true`，保留 `options`，提交时非空 text 追加到 selected。自由回答说明与备注标题放入各自 placeholder。备注按需展开；清除与取消按钮放到底部操作栏右侧，和导航/提交集中排列；单题直接提交，多题保留核对。卡片随内容自然增高，最大为对话区域可用高度，内容过长仅内容区滚动，页头与操作栏不随其滚走。任何表单重建必须保存并恢复页面、对话、请求面板及 ask-content 的滚动位置，禁止交互后跳顶。
- 问卷顶栏必须显示当前问题的原始 `question.header`，包括单题问卷；题号/总数/题型作为 muted 次要信息，核对页显示“核对答案”，不得用固定文案覆盖 header。
- 单选 preview 的选择区与预览区使用 `.ask-option` 统一外框，选中边框/背景作用于整个组合，不允许上下块边框重叠或断裂。折叠条使用紧凑样式并紧贴对应选项；折叠时不继承通用 details 的大间距，展开后再为正文增加间距。展开项索引保存在问卷本地 `previews` Set，任何表单重建均须恢复。
