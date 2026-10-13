# pi-atom-web 项目约定

pi-atom 系列的当前 TUI 会话 Web 扩展（命令 `/web` 与 `/web-wlan`），严格一对一绑定宿主进程当前会话。**本文件只留硬约束、待办与到 `DETAILS.md` 的索引；完整约定（按主题分 24 节，含每条的精确数值与踩坑依据）在 `DETAILS.md`。**

## 怎么读

1. 先读完本文件（约 7.7KB）。
2. 动手前按下面索引定位 `DETAILS.md` 的小节，**只读那一节**：`grep -n "^## 9\." DETAILS.md` 取行号后按 offset 读；或直接 grep 你即将改的标识符（如 `turn-live`、`compactionReason`、`--compose-height`）反查所属条目。
3. **不要整篇读 `DETAILS.md`**（约 85KB）。兼容层 API（Pi 正式扩展 API 之外补出的进程内桥接与 Web RPC）另查 `extensions/COMPATIBILITY-API.md`。
4. 新增或修改约定时：细节写进 `DETAILS.md` 对应小节（并在下面索引补一行触发条件）；只有普适红线才进本文件。

## 硬约束

- **架构**：Vue 3 runtime + Pinia + Vue Router（memory history），入口 `web/main.js`，组件用普通 JS `h()` + Composition API。禁止 SFC、构建工具、外部 CDN 与单体 DOM 渲染。见 §1。
- **协议双份**：`shared/protocol.ts` 与 `shared/protocol.js` 必须同时改。少一份时 `validateField` 的 default 分支会让**整个 patch 被客户端静默丢弃**（无报错、UI 不更新）。见 §2。
- **扩展后端只用 `.ts`**：已复现加载器缓存原生 ESM `.js`（`/reload` 仍调旧工厂），不要改回 `.js`；浏览器侧继续用 `.js`。见 §1。
- **安全**：Markdown/HTML 一律清洗，绝不把不可信内容当 HTML，绝不执行 TUI 组件或第三方代码；任何界面都不回显连接凭证。
- **性能红线**：禁止为历史条目开启 `content-visibility:auto`（实测产生隐形空白并放大 scrollHeight）；消息区必须按「轮是否结束」分流——已结束的轮只由 messages 派生，还在进行的那一整轮由 live 区渲染，禁止每个增量重建完整 transcript
- **对齐与居中是硬要求**：新增图标、按钮、状态行、行号列时必须先确定垂直居中方式、水平对齐参照、背景是否需不透明，改完自己量一次（`getBoundingClientRect` + `getComputedStyle`），不要凭感觉。
- **测试策略**（用户 2026-09-18 / 09-22 / 09-23 三次明确，2026-09-25 追问「每次都要跑测试吗」后收紧成最终档）：**测试文件一律不写、不改、不跑**——纯样式与视觉改动如此，协议、store 行为、组件交互逻辑、后端扩展等行为改动也如此；「行为变了要回头修既有用例」这条**取消**，测试文件由用户自己维护。改完只跑 `node scripts/check.mjs`（秒级的语法与重复声明门），其余交给用户 `/reload` 目检。行为改动若会让 `test/frontend.test.js` / `test/browser/web.spec.js` 变红，**只在汇报里点名是哪几条、为什么红、要改成什么**，不动手。临时诊断探针也写在工作区临时文件、用完即删，绝不进 `test/`。
- **验证命令**：`npm run check`、`npm test`、独立 `npm run test:browser`（本机 npm 不在 PATH 时用 `node scripts/check.mjs`、`node scripts/test.mjs`、`node node_modules/@playwright/test/cli.js test`）。`check` 递归检查 `extensions/`、`shared/`、`web/` 下的 JS/TS 语法并拦截 CSS 的行首 `//`。禁止零测试假成功；测试不得调用真实模型或写真实会话。见 §23。
- **文档同步**：改扩展后同步 `DETAILS.md`（细节）、`README.md`、`CHANGELOG.md`；涉及**依赖、安装步骤、命令、端口或运行期文件**时再同步 `INSTALL.md`（面向 agent 的安装手册，`README.md` 顶部的一键安装 prompt 指向它）；涉及队列、UI 对话、自定义 Entry、package 适配、工具事件、历史窗口或派生状态接口时再加 `extensions/COMPATIBILITY-API.md`。文档一律中文。
- **边界**：不创建独立的 agent、项目管理或会话管理系统，一律通过扩展 API 收发消息与订阅事件。
- **package 专属内容只写适配目录**（用户 2026-09-26）：`web/components/**`、`web/stores/**`、`extensions/index.ts` 这类通用文件里**不得出现某个 package 的工具名 / customType / 专属字面量**。需要差异就先给通用代码加**通用钩子**（注册表 / 查表 / 可选字段），字面量写进 `extensions/packages/<pkg>/` 或 `web/packages/<pkg>/`；「做不到」只指通用侧确实无可挂点，不指加钩子麻烦。样板：`web/packages/tool-profiles.js` + 包目录 `tool-profile.js`（`{ tool, label, solo, summary(args), icon: { name, markup } }`）。CSS 例外按**形状**写（如 `:not(:has(.disclosure-block))`），不为 package 往通用组件塞自有 class。组件与本地 CSS 仍惰性，纯数据清单可静态登记。见 §21。
- **提问一次问完**：同一主题的设计岔路（口径、分子/分母、实时值要不要、无数据时怎么显示）必须**合并成一轮** `ask_user_question`（最多 4 问）问完，不得拆成多轮追问。
- **探查只用沙箱 JavaScript**：本机 shell 是 PowerShell，`grep`/`rg`/`cat -n`/`find`/`for f in $(...)` 会报错或语义不同；跨文件与大输出探查一律 `ctx_execute(language:"javascript")` + fs/正则，并用 `ctx_batch_execute` 一次把待改文件的相关片段取齐。批量 `edit` 每批 ≤3 条且先确认锚点（一条不匹配 → 整批不生效）。
- **先给能看的最小闭环**（用户 2026-09-23 嫌执行过程过长）：口径/数值/视觉类改动先做到「用户 `/reload` 就能看到结果」，确认后再补落盘、测试与五份文档；诊断类提问先回答原因、再问要不要直接实现，不默认升级成完整特性。验证只跑两轮（一次针对性子集，必要时再一次全量）。见 §23。
- **单点改动走最省档**（用户 2026-09-23 第四次嫌执行过程长，明确选定的默认档位）：指向明确的单点改动（删一个节点、改一句文案、调一个数值）只做「读相关代码 → 改 → `check` → 汇报」，**不写也不跑任何测试、不写临时 Playwright 探针、不回头改既有用例、不跑全量套件**，目标 4–6 次工具调用；汇报里给出数值与依据，目检交给用户 `/reload`。测试变红、或行为真的变了，才升级处理。
- **不顺手删导出符号与死代码**：只做被要求的那一处。删一个导出函数会连带改测试与文档，成本翻倍（实例：删 `failureReason()` 多花 ≈6 次调用）；需要清理时用户会明说，或另开一轮。
- **禁止为视觉/文案改动写临时探针**：「样式改动不跑测试」明确扩展到**也不许临时写 spec 「量一下」**（写临时 spec + 跑 + 删 + 清 `test-results` 实际花 ≈5 次）；真的缺工具就在工作区临时文件里量，用完即删，没有就只给数值推算。
- **edit 用整行/整段锚点；文档与记忆一律走 `edit`/`write`/沙箱 JS**：半行锚点会吞掉整句（本轮吞掉一个 CHANGELOG 条目标题），在 shell 里塞含中文/反引号/正则的文本会被 bash 当命令替换或语法错误（本轮因此多花 5 次）。
- **文档「改到不谎」而不是「五份全同步」**：`DETAILS.md` + `CHANGELOG.md` 必改；`README.md` / `COMPATIBILITY-API.md` 只在描述真被改到才动，没动的在汇报里声明。
- **回复语言**：中文。

## DETAILS.md 索引

| 节 | 主题 | 什么时候读 |
|---|---|---|
| §0 | 术语表 | 沟通命名、文档措辞、把中文叫法对回代码标识时 |
| §1 | 架构、目录与产物边界 | 新增目录或依赖、改 `web/` 入口、后端文件扩展名、`.agents/skills/`、`node_modules` 静态资源挂载（`web/vendor/` 不存在）与 `INSTALL.md` |
| §2 | 协议字段与 SSE 传输 | 加改快照与 patch 字段、历史窗口分页、重连看门狗、`/reload` 实例交接 |
| §3 | 扩展入口、HTTP 服务与局域网模式 | 改 `/web*` 命令、静态资源白名单与 `resolveWebAsset`、`0.0.0.0` 绑定与网卡列表、固定端口网关与 `/<会话短码>/` 前缀、固定凭证与 `token.key`、工作区文件/Git RPC 与监听 |
| §4 | 派生状态持久化与会话统计 | 写 `.pi/atom/<sessionId>/web-state.json`、轮数/Token/成本统计、生成速度 tok/s 口径、命令与 notify 镜像 |
| §5 | UI 桥接、工具事件与自定义 Entry | 桥接 select/confirm/input/custom、branch 的 custom Entry、工具事件字段裁剪 |
| §6 | 页面骨架、滚动与性能禁令 | 改布局、`html/body` 滚动、`#scroll`、`content-visibility`、通用侧栏与文件/Git 工作面板 |
| §7 | 偏好持久化、设置页与内容列宽度 | 新增偏好键、设置页分类、`ColumnResizer` 与安全区 |
| §8 | 消息区结构、按轮分流与用户气泡 | 动 `#message-history`/`#message-live`、进行中的那一轮归谁渲染、用户气泡 |
| §9 | 按轮折叠（TurnGroup）与中间过程组（TurnStage） | 改 `turnGroups.js`、`splitTurnStages()`、轮次标题计数顺序、折叠展开时机、时间轴圆点与线段、组内缩进与吸顶层级 |
| §10 | Thinking 块与耗时计测 | 思考块默认开合、后端权威计时、流式进行中的 timing 发布 |
| §11 | 工具卡渲染与 pi 系统工具适配 | read/write/edit/bash 等专用视图、diff 行号、纯文本输出不走 Markdown |
| §12 | 折叠块基座、类型图标与吸顶层级 | 改 `DisclosureBlock`、summary 吸顶、`z-index` 与特异度、状态三色规则 |
| §13 | Prompt 提交、乐观消息与队列 | 提交清空与恢复、乐观临时消息、`prompt-queue.ts`、引导送达推定 |
| §14 | 图片附件与全屏预览 | 附件采集、缩略图条、`PreviewImage` |
| §15 | 输入区 Composer：模型、思考级别、上下文环与按钮 | 模型与思考级别选择器、`ContextRing`、发送与停止同位按钮 |
| §16 | 状态栏、图标与会话详情弹层 | 状态栏刷新与几何、`icons.js`、tok/s 展示与 `≈`、会话详情与互斥弹层 |
| §17 | 代码块、行内代码与字体栈 | `codeBlock()`、行号 gutter、行内 code 标记、字体栈 |
| §18 | 状态提示行、每轮徽标与用户提示词状态行 | 命令与中断横线、轮次完成徽标、用户消息编辑与分支箭头 |
| §19 | 上下文压缩的页面表现与耗时 | `/compact`、压缩块、手动与自动分流、`compactionReason` 与耗时 |
| §20 | 活动组件栏与扩展请求面板 | `ActivityBar` 的 tab 排序配色与折叠、扩展请求大框、阻塞提示 |
| §21 | 第三方 package 兼容层 | 新增或迁移 `extensions/packages/`、`web/packages/`、惰性激活 |
| §22 | ask_user_question 问卷卡片 | 问卷题型、自由回答存储、preview 的 Markdown 与硬换行 |
| §23 | 测试、验证与文档同步 | 加测试、跑验证、决定该改哪几份文档、执行预算（提问/探查/编辑/验证的省轮次规则） |
| §24 | 通用侧栏与文件、Diff、Git 工作面板 | 改 SidePanelHost 注册表、工作区 RPC、文件版本/监听、Git 操作与冲突编辑 |

## 待办

- **文件引用与上传（TODO：已定稿但**暂不实现**，用户 2026-09-25 明确“先把这个标记为 TODO，先不实现”）**：完整口径在 [`docs/file-mention-and-upload.md`](docs/file-mention-and-upload.md)。要点：Pi 内容块无文件类型、浏览器给不出绝对路径、`/api/action` 无体积上限这三条把解法压到只剩「`@` 引用 + 服务端原生对话框 + 新的流式上传端点」；中途设计过的「服务端按 name+size+mtime 反查定位」已删除，不要重新发明。开工第一步是先实测网关转发 body 是不是流式。

- **执行轨迹与上下文页改为独立页面**：两者的 tab 目前都带 `hidden: true` 暂特隐藏（`ViewTabs` 只渲染对话与设置，也不再作为默认视图选项）；轨迹视图代码（`ConversationFeed` 的 `trace` 分支）与 `ContextView` 都保留、无 UI 入口。独立页面完成后去掉 `hidden`、把 `DEFAULT_VIEWS` 加回候选，并恢复设置页的「打开页面时显示」项与行为分类标题。
- **Web 网关的加固**（固定端口带出来的新面，详 DETAILS §3）：局域网网关（31360）目前不校 Host/Origin、网关本身不鉴权（凭证仍由每个请求带给 pi 服务自己校）；注册密钥在 Windows 上只是 `0600` 请求；固定端口被占时只提示、不自动改选邻近空闲端口。
- **`/web-wlan`（监听 `0.0.0.0`）的安全与校验**：当前按约定先不做，凭证（URL 片段里的随机 token）是唯一凭据。待补：
  - 恢复 Host/Origin 白名单：只放行回环与本机网卡地址（防 DNS rebinding / CSRF），并决定是否允许用主机名访问。
  - 静态资源是否也要求凭证；局域网请求是否只放行 SSE 与 action。
  - 闲置回收策略（如 N 分钟无活动自动退回仅 loopback）与 TUI 风险提示的强度。
  - 局域网访问的审计与限流（记录来源 IP、限制失败尝试）。
