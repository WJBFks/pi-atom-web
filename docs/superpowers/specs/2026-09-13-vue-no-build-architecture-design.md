# pi-atom-web Vue 3 No-Build 架构重构设计

## 目标

将现有单体原生 DOM 前端重构为以下技术栈，同时保持当前产品边界和已有行为：

- Pi Extension + TypeScript
- Node.js 原生 `http`
- REST/fetch + SSE
- 为未来 Terminal/PTY 预留 WebSocket 边界
- Vue 3 no-build
- Pinia
- Vue Router
- 浏览器原生 ESM

本次重构不增加会话管理、Settings、Terminal 等产品功能。Web UI 继续严格一对一绑定宿主 Pi TUI 的当前会话。第一阶段 Router 只承载当前对话页和兜底路由。

## 成功标准

1. 现有 Web 功能和交互行为保持一致，包括消息流、Thinking、工具调用、模型与思考等级选择、状态卡片、扩展请求、Ask User、custom terminal、命令和 `/reload`。
2. 不引入 Vite、Webpack、Rollup、Parcel、esbuild、前端转译、Vue SFC、JSX/TSX、React 或 Nuxt。
3. 浏览器直接执行普通 JavaScript ESM；Vue、Pinia、Vue Router 及其浏览器运行时全部由本地 Node HTTP 服务提供，不连接 CDN。
4. SSE 数据及时展示；高频流式更新只影响对应的实时消息或工具卡，不重建历史消息、Composer、状态按钮和无关弹窗。
5. 路由切换、组件卸载、reload 和服务关闭时正确清理 SSE reader、AbortController、timer、ResizeObserver、DOM listener 和 xterm 实例。
6. 保持当前 loopback、随机凭证、Host/Origin、Bearer Token、sessionId 校验及请求体限制。

## 迁移策略

采用渐进替换，不进行一次性重写。

每一阶段都保持应用可运行：先加入浏览器 ESM 依赖和基础应用壳，再建立协议适配与 Pinia stores，随后按区域迁移 DOM。一个区域迁入 Vue 后立即删除该区域对应的旧 DOM 写入逻辑，避免长期保留两套事实源。

不先进行一轮“原生 JS 模块化”再改 Vue。只有能够直接成为最终 Vue 架构组成部分的协议、API、格式化和纯函数模块才提前抽取。

## 总体架构

```text
Pi APIs / events
       │
       ▼
Pi Extension TypeScript
       │  归一化 Snapshot / Action / Dialog
       ▼
Node http server
       ├── static native ESM
       ├── POST /api/action
       └── GET /api/events (SSE)
                    │
                    ▼
              transport layer
                    │
                    ▼
              Pinia stores
                    │
                    ▼
          Vue components / Router
```

当前没有需要双向高频传输的独立功能。普通操作继续使用 HTTP POST，服务端事件继续使用 SSE。只有未来加入 Terminal/PTY 时才实现 WebSocket；WebSocket 不进入本次代码范围。

## 目录设计

```text
extensions/
├── index.ts
├── server.ts
├── dialogs.ts
└── ask-user.ts

shared/
└── protocol.js

web/
├── index.html
├── main.js
├── app.js
├── router.js
├── style.css
├── api/
│   ├── actions.js
│   └── event-stream.js
├── stores/
│   ├── session.js
│   ├── conversation.js
│   ├── composer.js
│   └── dialogs.js
├── views/
│   └── ChatView.js
├── components/
│   ├── AppShell.js
│   ├── conversation/
│   │   ├── ConversationFeed.js
│   │   ├── MessageItem.js
│   │   ├── ThinkingBlock.js
│   │   ├── ToolCallBlock.js
│   │   └── MarkdownContent.js
│   ├── composer/
│   │   ├── ComposerDock.js
│   │   ├── CommandMenu.js
│   │   ├── ModelPicker.js
│   │   └── ThinkingPicker.js
│   ├── dialogs/
│   │   ├── RequestDock.js
│   │   ├── AskUserForm.js
│   │   └── CustomTerminal.js
│   └── status/
│       ├── SessionStatus.js
│       └── StatusPopover.js
└── vendor/
```

`vendor/` 只作为稳定的浏览器入口或必要的 import-map 目标；实际包文件仍来自项目 npm 依赖，由 `server.ts` 白名单映射。禁止提供任意文件路径访问。Vue 使用 `vue.runtime.esm-browser.prod.js`，组件使用 `defineComponent()`、Composition API 和 `h()` render function；不使用需要运行时模板编译和 `unsafe-eval` 的字符串模板。Pinia 和 Vue Router 使用各自固定版本的 browser ESM 构建，并与应用共享同一个 Vue 实例。

浏览器通过固定 import map 解析 `vue`、`pinia` 和 `vue-router` 等裸模块名。import map 内容是构建时固定文本，其 SHA-256 hash 写入 CSP；不放宽为 `unsafe-inline`，也不连接外部源。服务端测试必须验证所有 import-map 目标均能在带现有安全头的页面中加载。

## Shared Protocol

新增前后端都能直接导入的 `shared/protocol.js`，用普通 ESM 实现运行时 validator，并以 JSDoc 声明类型。TypeScript 扩展和浏览器 transport 使用同一实现，避免两套 schema 漂移。协议包含 `schemaVersion`、严格 action union、字段长度限制和嵌套结构校验，并集中声明：

- `Snapshot`：首次连接和恢复同步时的完整当前状态。
- `ServerEvent`：首次 Snapshot 后的领域增量事件，包括会话字段变更、消息新增/更新、实时消息更新、工具生命周期、请求变化、统计变化和 agent 状态变化。
- `Action`：浏览器到服务端的命令式操作。
- `DialogRequest` / `DialogResponse`：扩展请求的双向结构。
- `RunningTool` / `ToolTiming`：工具生命周期与耗时。

Pi 的内部事件不直接泄露为浏览器协议。后端负责转换成稳定的 `ServerEvent`。首次连接发送带 `streamId`、`revision` 的 Snapshot；后续事件携带连续 `sequence` 和所属 `sessionId`。客户端发现流标识变化、序号缺口、会话变化或无法应用事件时主动重连，服务端用新 Snapshot 恢复一致状态。

协议层强制提供带会话命名空间的稳定实体 ID：历史消息使用 branch entry ID，内存通知和命令记录在创建时生成 UUID，live turn 使用稳定 run ID，工具使用 toolCallId。会话切换、分支变化和 compact 后，store 按新 Snapshot 中仍存在的 ID 修剪展开状态、Markdown 缓存和计时数据；禁止以数组下标或时间戳作为 Vue key。

现有 32ms 合并窗口只合并同一实体的冗余更新，不再重复序列化和发送完整历史。文本增量按到达顺序拼接；会话字段、统计值和同一工具的连续状态可以在窗口内保留最后值。迁移阶段允许旧 Snapshot 与增量事件并存，但最终前端只有协议适配层接触二者，stores 和组件只接收归一化后的 mutation。

协议继续保留：

- 首次 SSE 连接立即发送 Snapshot，随后只发送增量事件。
- 15 秒 heartbeat。
- 客户端断线重连。
- `/reload` 的旧 `instanceId` 在 POST 前保存；只有连接到新实例后刷新一次。
- 所有 action 携带并校验当前 `sessionId`。
- SSE `write()` 返回 `false` 只代表背压，不移除客户端。

## Pinia 状态边界

### session store

负责低频全局状态：会话 ID、标题、文件路径、工作目录、实例 ID、模型列表、当前模型、思考等级、busy 状态和统计信息。

Snapshot 到达时逐字段比较并赋值。状态栏每秒计时只更新对应文本所依赖的时钟值，不重建按钮或弹窗节点。

### conversation store

负责历史消息、实时消息、运行中工具、工具耗时、Thinking 展开状态和滚动跟随信号。

历史列表按稳定 message key 归一化。未变化的消息对象保留引用；只替换内容、usage 或工具状态发生变化的实体。`liveMessage` 与历史消息分离，流式 delta 不触碰历史数组。

用户操作过的 Thinking 展开状态单独保存，完成时仅自动折叠未被用户操作的块。

### composer store

负责草稿、发送状态、斜杠命令匹配、模型选择器、思考等级选择器和瞬时通知。命令筛选使用计算属性；输入事件不写入其他 stores。

### dialogs store

负责普通扩展请求、Ask User 草稿、custom terminal 请求和响应状态。Ask User 草稿按请求 ID 保存；请求重绘不丢失展开状态、输入、焦点和滚动位置。

stores 之间通过小型 action 协作，禁止相互订阅形成循环。DOM 节点、xterm 实例、AbortController 和 ResizeObserver 不放入 Pinia；它们属于组件或 composable 生命周期。

## Vue 组件边界

根组件只负责页面壳、RouterView、全局 transport 启停和主题初始化。

`ChatView` 只组合固定 header/sidebar/toolbar、ConversationFeed 与 ComposerDock。消息、Thinking、工具调用、代码块、状态弹窗、模型选择器和请求表单各自作为有稳定 props/emits 契约的组件。

普通文本作为 text vnode 输出，由浏览器转义。Markdown 仍由 marked 解析并经 DOMPurify 清洗；只有清洗后的结果可以写入 vnode 的 `innerHTML`。代码块继续统一经过现有高亮、语言、行数、行号和复制逻辑。

xterm 封装在 `CustomTerminal` 内：挂载时创建，输入按序发送，卸载时 dispose。ResizeObserver、window/document listener 和 timer 使用 composable 注册，并在 `onUnmounted` 中释放。

## Router

使用 Vue Router 4 的 `createMemoryHistory()`。页面 hash 继续只承载现有 bearer token，Router 不读写 fragment，从根源上避免刷新后把 `/chat` 误识别为 token。启动器只接受符合服务端随机凭证格式的 hash；首次读取后写入 sessionStorage 并清理地址中的凭证。缺失或畸形凭证进入明确的未授权状态，不能覆盖已有有效凭证。

第一阶段路由：

- `/`：重定向到 `/chat`。
- `/chat`：当前 TUI 会话对话页。
- 未匹配路径：重定向到 `/chat`。

路由变化不得创建第二条 SSE 连接。transport 由应用级 composable 持有；未来若出现需要独立连接的路由，则在 route scope 内使用 AbortController 并明确清理。测试覆盖首次 `/#token`、凭证迁移后刷新、缺失凭证和畸形 hash。

## 实时数据与性能

性能目标是及时展示和少量局部更新，具体约束如下：

1. SSE transport 只使用能够携带 Authorization header 的 `fetch + ReadableStream reader`，负责分帧、解析、顺序检查和重连，不使用原生 EventSource，也不直接操作 DOM。
2. 新 Snapshot 先在 transport 层校验，再由 store action 应用。
3. 消息、工具和请求按稳定 ID 建索引；使用 keyed component，避免 `innerHTML` 替换整段 transcript。
4. 历史消息与实时消息使用不同容器和响应式路径。流式期间不遍历或复制完整历史列表。
5. 高频事件到达后立即写入非 DOM 状态，并在一次 animation frame 内最多提交一次可视 UI flush；文字 delta 不人为延迟超过一帧。后台标签页使用定时兜底提交最新状态，不能依赖 `requestAnimationFrame` 才保持数据一致。
6. 工具运行时间和 Thinking 时间共享一个低频时钟源，不为每张卡创建独立 interval。
7. 状态统计按字段原地更新；hover/focus 中的按钮和 popover 不因每秒刷新被替换。
8. Markdown 只在对应消息文本变化时重新解析；每个消息 ID 只保留最新一次解析结果，实体移除时同步清理。流式期间的未完成代码围栏不做自动语言识别和完整高亮，消息完成后再执行最终高亮，避免持续增长文本产生近似二次工作量。
9. 模型列表、命令匹配和工具上下文使用 computed/索引结果，避免在模板 render 中重复做全量扫描。
10. 自动滚动只操作消息滚动容器；通过“接近底部”阈值判断是否跟随，用户向上浏览时不抢滚动位置。
11. 长消息列表首先保持组件稳定和增量更新；只有实际性能数据证明 DOM 数量成为瓶颈时才引入虚拟列表，避免破坏动态高度、锚点和折叠交互。
12. 开发期增加可选的渲染计数/性能标记，验证一次 delta 不会触发 Composer、Sidebar、历史消息和无关弹窗更新；生产界面不展示这些内部指标。

## 错误处理与恢复

- SSE 连接状态明确分为 connecting、connected、reconnecting、failed。
- 网络断开后使用有上限的指数退避并加入 jitter；成功连接后重置退避。
- transport 是应用级单实例状态机。每次连接分配 generation；停止时先标记 stopped，再 abort reader 并清除 retry timer；所有回调写 store 前检查 generation，旧连接的迟到数据直接丢弃。
- 新快照只有通过基本结构校验后才能进入 store；单次坏数据记录错误但不破坏最后一个有效页面状态。
- action 使用统一错误类型，界面显示操作级反馈；发送失败时保留草稿。
- reload 导致的 fetch 网络中断不清除旧实例标记。
- 组件卸载时取消未完成请求，迟到响应不得写回已卸载界面。
- custom terminal 输入保持串行队列和 4096 字符限制。

## 样式与用户体验

重构保持当前视觉效果、字体、固定布局、Composer dock、Thinking/Tool 状态色和响应式行为。组件化不能改变现有 CSS 设计约束。

交互中的元素保持稳定 DOM 身份，避免 hover 闪烁、焦点丢失和弹窗意外关闭。加载时优先显示页面壳和最近有效快照；连接状态明确但不遮挡已有内容。模型、思考等级和扩展请求提交使用乐观禁用与明确结果反馈，不使用无意义动画。

## 测试与验收

保留现有 Node 测试，新增以下层级：

1. Shared Protocol 的 action/snapshot 校验测试。
2. Pinia store 的实体归一化、稳定引用、Thinking 手动状态和局部更新测试。
3. SSE 分帧、重连、reload handoff、取消和资源清理测试。
4. Router token 迁移、默认路由、兜底路由和单 transport 生命周期测试。
5. Markdown 清洗、工具合并、Ask User 草稿、模型筛选和思考等级约束测试。
6. 使用 Playwright 驱动真实浏览器，提供独立的 `npm run test:browser`：验证流式及时性、滚动保持、输入焦点、hover 稳定、弹窗外部点击、xterm 清理和 `/reload` 自动刷新。浏览器测试工具只作为开发依赖，不参与前端运行和发布。
7. 性能验收使用固定长会话 fixture 和可控 SSE 流速：连续流式更新时历史消息节点身份保持稳定；无关组件不重复渲染；单帧最多一次高频可视提交；停止 transport 后活动连接和重试 timer 为零；记录长消息输入延迟和更新耗时基线，避免只凭主观感受判断。
8. `npm run check` 递归检查所有 `web/**/*.js`、`shared/**/*.js` 和 `extensions/**/*.ts`，不能依赖容易漏文件的手写清单。

每个迁移阶段必须通过 `npm run check`、`npm test` 以及对应浏览器验收后再删除旧实现。

## 文档与版本

实现完成后更新项目 README、CHANGELOG、package version 和项目 AGENTS.md 中的架构说明。文档使用中文。提交只包含 pi-atom-web 自身改动，不带入父仓库现有未提交文件。
