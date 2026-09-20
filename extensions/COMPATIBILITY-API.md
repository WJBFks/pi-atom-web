# pi-atom-web 兼容层 API

本文说明 pi-atom-web 为 Pi 补充的额外接口。项目统一把这些接口称为**兼容层 API**。

兼容层 API 不是 Pi 官方扩展 SDK 的组成部分，也不会把新的全局方法注入第三方扩展。它位于 pi-atom-web 的扩展进程中，把 Pi 的正式 API、运行时事件和少量可探测的内部能力转换成适合浏览器使用的结构化接口。Web UI 只调用兼容层协议，不直接读取 Pi 对象。

## 设计边界

- 优先使用 Pi 的正式 API；正式 API 信息不足时才观察运行时对象。
- 运行时能力必须先探测再启用。缺失时回退、停用相关能力或保留通用界面，不因兼容失败阻止扩展启动。
- 对 Pi prototype 的观察器使用 `Symbol.for()` 防止 `/reload` 重复包装。
- 兼容层只服务当前宿主进程、当前会话，不创建独立 agent 或会话系统。
- 送往浏览器的数据必须通过 `shared/protocol.ts` 校验；扩展拥有的对象必须先做有界、可序列化归一化。
- 第三方 package 的专用逻辑只放在 `extensions/packages/<package-id>/`，并在检测到对应 package 行为后按需加载。

## 分层

```text
Pi 正式 API / 运行时事件 / 可探测内部对象
                    │
                    ▼
        extensions/* 兼容层模块
                    │
                    ▼
      snapshot / patch / action 协议
                    │
                    ▼
                 Web UI
```

兼容层有两类接口：

1. **进程内模块 API**：供 `extensions/index.ts` 组合使用。
2. **Web action 与状态 API**：经认证 HTTP action 和 SSE snapshot/patch 提供给浏览器。

## Prompt 队列兼容 API

实现位于 [`prompt-queue.ts`](prompt-queue.ts)。详细的 Pi 系统 API、限制和 Web RPC 示例见 [`../docs/pi-prompt-queue-api.md`](../docs/pi-prompt-queue-api.md)。

### 安装与会话捕获

```ts
const promptQueues = installPromptQueueRuntime(AgentSession);
```

`installPromptQueueRuntime()` 观察 `AgentSession._bindExtensionCore()`，在 Pi 为扩展绑定 core 时捕获对应 `AgentSession`。若当前 Pi 没有该入口，则返回同形状的 bridge；调用方可通过 `has(sessionManager)` 判断该会话是否已经捕获。

该观察依赖 Pi 内部绑定时机，因此属于版本敏感接口。正式 API 回退是 `pi.sendUserMessage(content, { deliverAs })`，但回退无法提供完整的查看、编辑和删除能力。

### 进程内接口

```ts
interface PromptQueueBridge {
  has(sessionManager): boolean;
  attach(session): void;
  snapshot(sessionManager): PromptQueueSnapshot;
  listen(sessionManager, listener): () => void;
  add(sessionManager, kind, text, images?): Promise<PromptQueueSnapshot>;
  submit(sessionManager, content, options?): Promise<void>;
  remove(sessionManager, target): Promise<{
    removed: PromptQueueItem;
    queue: PromptQueueSnapshot;
  }>;
  update(sessionManager, target): Promise<{
    previous: PromptQueueItem;
    updated: PromptQueueItem;
    queue: PromptQueueSnapshot;
  }>;
}
```

队列项结构：

```ts
interface PromptQueueItem {
  id: string;                       // 当前 revision 内有效的派生 ID
  kind: "steer" | "followUp";
  index: number;
  text: string;
  images: Array<{
    type: "image";
    mimeType: string;
    data: string;                   // base64
  }>;
}

interface PromptQueueSnapshot {
  revision: number;
  count: number;
  steering: PromptQueueItem[];
  followUp: PromptQueueItem[];
}
```

Pi 的公开 `getSteeringMessages()`、`getFollowUpMessages()` 和 `queue_update` 只提供文本。兼容层在可用时读取 `session.agent.steeringQueue.messages` 与 `followUpQueue.messages`，以保留完整图片；旧运行时回退为文本队列。

Pi 会先发只含文本的 `queue_update`，随后才把含图片的完整 user message 放入 agent queue。兼容层在 `prompt()` 的 preflight 确认消息已经启动或排队后，必须再次读取并发布权威 `promptQueue`，不能让浏览器停留在较早的纯文本 patch。

Pi 0.85 在消费纯图片消息时不会移除公开文本镜像里的空字符串。兼容层在 user `message_start` 时对照真实 agent queue，清理这一残留并发布正确 revision，避免 `pendingMessageCount` 和 Web 队列永久非零。

Pi 没有单条修改、移动或删除队列项的正式原语。`update()` 和 `remove()` 使用以下模拟事务：

1. 校验客户端最后看到的 `revision` 和派生 `id`；
2. 清空 Pi 队列；
3. 按原类别和顺序调用 `steer(text, images)` / `followUp(text, images)` 重建；
4. 抑制重建过程中的中间空队列 patch；
5. 发布最终真实队列。

清空和重新入队不是 Pi 事务。任一消息重入失败时 action 返回错误，同时仍发布当前真实队列。

### Web action

| action | 用途 |
| --- | --- |
| `queue_add` | 添加 Steering 或 Follow-up，支持文字、图片或纯图片 |
| `queue_update_item` | 修改文字/图片，或在两种队列之间转换 |
| `queue_remove` | 删除单条并返回完整 `removed` |
| `send` | 普通 Composer 提交；运行中固定按 Follow-up 进入队列 |

更新和删除必须带 `revision`。队列变化通过 `promptQueue` patch 推送；snapshot 也包含当前 `promptQueue`。

Web 不另外规定图片数量和字节上限，只验证图片数据结构与 base64；实际可接受范围由 Pi、当前模型和 provider 决定。

## UI 对话兼容 API

实现位于 [`dialogs.ts`](dialogs.ts)。

```ts
const dialogs = bridgeDialogs(ui, getSessionId, changed, adapters);
```

该模块包装共享 `ctx.ui` 的 `select`、`confirm`、`input`、`custom` 和 `editor`：

- TUI 原调用仍然存在，浏览器响应与 TUI 响应通过 `Promise.race()` 竞争完成；
- 每个请求带随机 `id` 和当前 `sessionId`，跨会话响应会被拒绝；
- `select` 返回原选项值，`confirm` 返回 boolean，`input` 返回 string；
- `custom` 默认镜像同一个 TUI component 的 render 行，并把浏览器键盘输入交给 `handleInput()`；
- `editor` 没有 Pi 可用的浏览器关闭钩子，只作为 `terminalOnly` 请求展示，必须在 TUI 完成；
- package adapter 认领的 `custom` 请求使用 package 自己的结构化 request/result，不再退化为终端行镜像。

返回接口：

```ts
interface DialogBridge {
  list(): DialogRequest[];
  respond(id, value, cancel): void;
  close(): void;
}
```

浏览器使用 `dialog_response` action 回答请求。`close()` 会结束未完成请求并恢复原始 `ctx.ui` 方法。

## 自定义 Entry 兼容 API

实现位于 [`custom-entry.ts`](custom-entry.ts)。

```ts
installEntryRendererObserver(ExtensionRunner);
onEntryRendererObserved(ExtensionRunner, listener);
normalizeCustomEntry(entry, namespace, options);
```

Pi branch 中任意 `type: "custom"` entry 都会被转成 Web 的 `role: "customEntry"`，不按插件名特判。兼容层观察 `ExtensionRunner.getEntryRenderer(customType)`，取得第三方扩展实际注册的 TUI renderer，分别以折叠和展开状态渲染文本并去除 ANSI 控制字符。

浏览器不会执行 TUI component、插件 HTML 或脚本。renderer 缺失或失败时，仍转发经过 `toToolJson()` 归一化的原始 `data`，由 Web 按 JSON 或纯文本显示。

## 第三方 package 兼容 API

入口位于 [`packages/registry.ts`](packages/registry.ts)，package 实现位于 `extensions/packages/<package-id>/`。

```ts
const registry = createPackageCompatibilityRegistry(pi);
```

注册表接口：

```ts
interface PackageCompatibilityRegistry {
  start(toolStartEvent): void;
  end(toolCallId): void;
  takeCustom(factory): Promise<PackageClaim | undefined>;
  activePackageIds(): string[];
  clear(): void;
}
```

descriptor 用 package 的工具名和事件名检测安装/运行迹象。只有命中后才动态 `import()` 对应适配器；未安装时不加载、不报错、不警告。适配器可把工具事件、package 事件和 `ctx.ui.custom(factory)` 关联成一个结构化浏览器请求。多个适配器同时声称认领同一 factory 时返回 `undefined`，保留通用 TUI 镜像，避免错误接管。

当前已实现 `@juicesharp/rpiv-ask-user-question`。新增 package 兼容必须遵守项目技能 `pi-package-compatibility`。

## 工具事件安全接口

实现位于 [`tool-events.ts`](tool-events.ts)。

```ts
toToolJson(value): JsonValue;
normalizeRunningTool(event, previous?): RunningTool;
```

Pi 和第三方工具参数可能包含循环引用、`BigInt`、函数、symbol、异常 getter 或私有句柄。兼容层：

- 最大深度 20；
- 最多遍历 4096 个节点/数组项；
- JSON 预算 256 KiB；
- 循环引用、不可读取字段和不支持的值转换为文字标记；
- `normalizeRunningTool()` 只保留 Web 工具卡需要的字段。

单个工具事件无法编码时不能断开 SSE，也不能消耗事件序号。

## 历史窗口接口

实现位于 [`history-window.ts`](history-window.ts)。

```ts
HISTORY_TURNS = 10;
HISTORY_PAGE_TURNS = 5;
historyCutIndex(messages, maxTurns?);
windowedHistory(messages, maxTurns?);
olderHistory(messages, beforeIndex, maxTurns?);
```

这是 Web 历史分页的兼容接口：snapshot 只发送最近 10 轮，更早历史由 `more_history` action 按客户端最老 entry ID 向前取 5 轮，并通过 `prependMessages` patch 返回。普通 prompt 提交不得触发完整历史发送。

## Web 派生状态接口

实现位于 [`session-state.ts`](session-state.ts)。

```ts
createSessionStateStore({ cwd, sessionId, debounceMs? });
```

它保存 Pi 会话文件没有记录、但 Web 需要恢复的数据：

- Thinking 和工具最终耗时；
- 每轮处理耗时；
- 用户手动折叠状态；
- 命令、通知、状态和中止提示镜像。

存储位置为 `<cwd>/.pi/atom/<sessionId>/web-state.json`，使用同目录临时文件原子替换，单类数据最多 500 项。连接凭证、临时 Prompt、运行中状态和滚动位置不落盘。

## 上下文压缩兼容接口

`/compact` 与 Pi 自己的自动压缩都通过宿主事件暴露；Web 需要三样东西：命令记录上的执行状态、压缩条目本身、协议字段。

- 事件：`pi.on("session_before_compact" | "session_compact" | "session_compact_failed")`。这些是扩展面事件（`session_*`），不是 TUI 内部的 `compaction_start/end`。
- 命令记录（`displayRecords`，落盘 `web-state.json`）：**记录 id 在 `record.id` 上，不在 `record.message` 上**（消息 id 在序列化时才由 `withId` 写进去）。Web 执行 `/compact` 时把本次压缩绑到该记录：
  - 运行态 `compaction: { startedAt }` **只在 `displayMessages()` 的序列化输出上叠加**，不写进记录 —— 进程中途退出、`/reload` 或刷新都不会留下一个转不完的计时；
  - `session_compact` 成功时把 `{ startedAt, endedAt }` 写进 `record.message.compaction` 并落盘；`session_compact_failed` 不写，失败提示由 `context.compact({ onError })` 的 `ui.notify` 承担。
  - 落盘的完成态在**序列化时搬家**：若当前 branch 存在配对（`entry.parentId === record.anchor`）的 `type:"compaction"` 条目，`displayMessages()` 把 `compaction:{startedAt, endedAt}` 从命令记录移交给那条 `compactionSummary`（命令记录里删掉该字段，且不带 `undefined` 键），前端渲染在压缩块**下方**；没有配对条目时留在命令记录上，完成行不会丢失。运行态（只有 `startedAt`）始终只叠加在命令记录上、不落盘。
- 压缩条目：branch 里的 `type:"compaction"` entry（宿主 `CompactionEntry`：`summary` / `tokensBefore` / `retainedTail` …）被转成 `role:"compactionSummary"` 的 Web 消息（带 `tokensBefore`，配对时另带 `compaction`），前端渲染为「压缩」可折叠块（其下可跟一行完成状态）。它是纯派生输出，不进 `displayRecords`、不落盘。自动压缩（没有 `/compact` 命令记录）因此只有压缩块、没有完成行。
- 协议（`shared/protocol.ts` 双端同步校验）：`compactionSummary.tokensBefore`（可选、非负数字），以及任意消息项上的 `compaction: { startedAt, endedAt? }`（`endedAt >= startedAt`，`compactionField()` 同时服务命令记录与压缩条目）。客户端 `LiveFeed` 也依赖它：消息里存在「带 `compaction` 且无 `endedAt` 的命令消息」时，底部 live 区不再显示压缩状态（状态只出现在命令横线下方）。

## Agent 定义只读接口

实现位于 [`agent-resources.ts`](agent-resources.ts)。设置页的「技能 / 扩展 / 模板 / 定义」四个分类展示 pi 启动时自动装配的 Agent 定义，只读、不可编辑。

快照/patch 字段 `agentResources`（`shared/protocol.ts` 双端同步校验）：

```ts
{
  skills: ResourceEntry[];      // 来自 pi.getCommands() 的 source:"skill" 项，name 已剥离 "skill:" 前缀
  extensions: ResourceEntry[];  // 磁盘镜像扫描（见下）
  prompts: ResourceEntry[],     // 来自 pi.getCommands() 的 source:"prompt" 项
  definition: {
    contextFiles: { path, size }[];   // 全局 → 顶层父目录 → 当前目录
    systemPromptFile: string | null;  // 项目 .pi/SYSTEM.md 优先于全局
    appendSystemPromptFile: string | null; // 同上，APPEND_SYSTEM.md
    settings: { path, exists }[];    // 两级 settings.json
    packages: string[];              // 两级 settings.json 的 packages 声明
    projectTrusted: boolean;
  }
}
```

`ResourceEntry = { name, description?, path, source: "global"|"project"|"package", sourceName? }`（source 为 package 时 sourceName 为包名）。

数据来源约定：

- 技能/模板：`pi.getCommands()`（正式扩展 API）返回真实加载清单，含 npm 包与 `resources_discover` 动态上报；`sourceInfo.origin === "package"` 映射为 `package`，`scope === "project"` 映射为 `project`，其余为 `global`。`getCommands()` 抛错时降级为空列表。
- 扩展：Pi 未向扩展暴露已加载扩展清单，因此按 pi 的目录发现规则镜像扫描磁盘：全局 `~/.pi/agent/extensions`、项目 `<cwd>/.pi/extensions`、两级 settings.json 的 `extensions` 声明、以及 settings `packages` 声明的 npm pi-package（manifest `pi.extensions` 优先于约定 `extensions/` 目录）。包提供的扩展以包名为显示名。glob 模式不做展开（不命中即不列出）。
- 项目信任：`context.isProjectTrusted()` 为 false 时，项目级扩展、项目 settings.json 声明的扩展/包都不列出，与 pi 真实加载一致；上下文文件不受信任门控。
- 主题不在 `agentResources` 中：Pi 主题是 TUI 主题，与 Web UI 不兼容，Web 端有独立的主题偏好（`atom-theme`）。


## 会话树兼容 API

Pi 的会话是树结构（每个 entry 带 `id`/`parentId`，当前叶子决定可见分支），Web 的「平行会话切换」与「编辑提示词后重开该轮」都建立在这个模型上。

### 安装与会话捕获

`extensions/session-tree.ts` 用带 `Symbol.for("pi-atom-web.session-tree")` 防重复包装的 `AgentSession._bindExtensionCore()` 观察器捕获当前 AgentSession，以 `sessionManager` 为键存进 `WeakMap`（与 Prompt 队列同一手法，两者各自包装同一方法、互不影响）。

### 进程内接口

- `has(sessionManager)`：当前运行时是否支持会话树导航。不支持时上层降级（不渲染分支控件、不报错）。
- `navigate(sessionManager, targetId)`：调用 `AgentSession.navigateTree(targetId, { summarize: false })`——**同一会话文件内**切换活跃叶子，且不生成被放弃分支的摘要。
- 读取侧不走兼容层，直接用 `ctx.sessionManager` 的 `getEntries`/`getChildren`/`getEntry`/`getBranch`；缺少 `getEntries()` 的旧宿主退化为「无平行分支」（不下发 `branch` 字段）。

### Web action

- `edit_user_message` `{ sessionId, entryId, text }`：中断当前生成并等待空闲 → 置 `restarting` → 把被编辑的**用户 entry**交给 Pi 的 `navigateTree()`（由 Pi 选择其父节点、处理根消息并同步 Agent 上下文）→ 以新文本（携带原消息图片）重发；新用户消息因此成为原消息的**兄弟分支**。
- `navigate_branch` `{ sessionId, entryId }`：目标是兄弟用户消息；服务端解析其**子树末端**（`branchTip`：沿最新子节点一路向下）后导航，使切过去能看到该会话的完整后续。

### 依赖与回退

- 依赖 Pi 内部入口 `AgentSession.navigateTree` 与 `SessionManager.getEntries/getChildren/getEntry/resetLeaf`（非正式扩展 API，版本变动需回归）。
- 拿不到实例时 `has()` 为 false：前端不渲染分支控件，action 报「当前 Pi 运行时不支持会话分支切换」。
- 协议：消息新增 `timestamp`（数值）与 `branch`（`{ index, count, prev, next }`，仅 `count > 1`），快照/补丁新增 `restarting` 布尔；`shared/protocol.ts` 与 `.js` 双重校验。
- 分支归组使用逻辑分叉点：从用户 entry 的 `parentId` 向上跳过普通 `custom`、模型/思考级别、会话信息和 label 等不构成对话轮次的元数据 entry，停在最近的真实消息或结构边界。这样编辑重启后即使第三方扩展在新 Prompt 前调用 `appendEntry()`，新旧用户消息仍显示为 `1/2`、`2/2`。
- 快照和分支切换 patch 带 `historyRevision`。普通历史窗口更新仍按消息 id 求并集；同一 session 内 `session_tree` 使 revision 递增，并在同一 patch 下发当前分支窗口，浏览器据此替换旧分支历史，避免把 `1/2` 与 `2/2` 两条分支纵向拼接。
## 协议与版本约定

- `shared/protocol.ts` 是扩展端协议校验器，`shared/protocol.js` 是浏览器端内容同步副本。
- snapshot/patch 使用 `schemaVersion: 1`，事件带 `streamId`、`sequence` 和 `sessionId`。
- action 必须携带当前 `sessionId`；会话已经切换时拒绝执行。
- 兼容层依赖的 Pi 内部入口目前包括 `AgentSession._bindExtensionCore()`、`AgentSession.agent.*Queue.messages` 和 `ExtensionRunner.getEntryRenderer()`。
- 升级 `@earendil-works/pi-coding-agent` 后，必须重新验证这些入口；不可用时应保留正式 API 回退或通用 UI，不能静默产生错误数据。

## 新增兼容接口的要求

1. 先确认 Pi 正式 API 是否已经提供同等能力。
2. 把通用 Pi 兼容放在 `extensions/`；第三方 package 专用兼容放在 `extensions/packages/<package-id>/`。
3. 为能力检测、正常路径、缺失/失败回退和 `/reload` 防重复安装编写测试。
4. 为传到浏览器的结构补齐 `shared/protocol.ts` 与 `.js` 校验。
5. 更新本文、README、CHANGELOG 和必要的专项文档。
6. 明确标注依赖的 Pi 版本与内部入口，避免把兼容层 API 描述为 Pi 官方 API。
