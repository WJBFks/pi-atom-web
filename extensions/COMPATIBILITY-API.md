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
  noteDelivery(sessionManager, message): boolean;
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

### 引导送达推定

Pi 不记录用户消息的送达方式：`_queueSteer()` 递给 agent 的是 `{ role: "user", content, timestamp }`，落盘的 entry 里没有任何来源标记；宿主自己也是在 `message_start` 里按「文本相等」把消息从 `_steeringMessages` 里摘掉（先 Steering 后 Follow-up）。因此「这条消息是引导进来的」只能由兼容层推定：

1. 每次发布队列快照时，`trackSteering()` 把快照里**新出现**在引导队列的签名计入待送达（多重集合，上限 200）；
2. user `message_start` 时 `noteDelivery(sessionManager, message)` 按同一签名核销一条，返回 `true`；
3. `extensions/index.ts` 把导出的 `steeringSignature(message)` 追加到 `steeringDeliveries`（FIFO，上限 500）并写入 `web-state.json`；
4. 逐列历史时按 branch 顺序消耗该多重集合，命中的用户消息额外下发 `delivery: "steer"`，状态行因此显示「时间 · 引导」。
5. 前端 `turnGroups.js` 的 `isSteeringMessage()` 据此把这条消息归入**被它插话的那一轮**：不切断 `TurnGroup`、不触发自动折叠，气泡渲染在原消息流程的折叠块内，并在轮次标题最前面计入「引导`n`」（`turnCounts().steers`）。

签名为 `{FNV-1a hash}:{字节长度}`（文本 + 图片的 mimeType/data），只存摘要不存原文。队列快照不可用而退回公开文本镜像时（纯图片引导），签名会缺少图片部分而无法命中。

已知偏差与限制：

- **只能覆盖扩展加载之后的消息**：更早的历史在会话文件里没有留痕，不猜测。
- 引导项被删除或改文字后，旧签名会留在待送达里；之后恰好发送同一文本的普通消息会被误标（与宿主自己的文本相等判定同量级）。
- 旧运行时的 `_bindExtensionCore()` 不可用时没有队列观察入口，`noteDelivery()` 恒返回 `false`，退化为不显示标记。

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

工具在**会话转录**里的显示形状由 package 侧的纯数据清单声明：`web/packages/<package>/tool-profile.js` 导出 `{ tool, label?, solo?, summary(args)?, icon?: { name, markup } }`，`web/packages/tool-profiles.js` 在模块加载时登记。通用组件只查 `toolProfile()` / `isSoloTool()` —— `ToolCallBlock.js` 用它取卡片标题，`turnGroups.js` 用 `solo` 决定该工具卡与它的结果条是否平铺在中间过程组之间（轮次标题仍计入「工具调用」）。`summary` 自定义折叠态摘要（返回空串 = 退回通用摘要，档案侧抛异常一律吞掉）；`icon` 由 `web/icons.js` 在模块求值时登记进图标表，**与内置同名不覆盖**，图标文件本身必须是纯数据（不能 import 依赖 vue 的 `icons.js`）。这份清单是**静态导入**的（组件与本地 CSS 仍按上文惰性导入），因为历史会话里的旧卡片必须在首个请求到达之前就渲染正确；未安装该 package 时条目只是永不命中、不报错、不警告。


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
- 生成速度的累计观测（`generation`，见「生成速度兼容接口」）；
- 以「引导」方式送达的用户消息签名（`steeringDeliveries`，见「引导送达推定」）；
- 压缩条目的触发原因（`compactionReasons`，见「上下文压缩兼容接口」）；
- 用户手动折叠状态；
- 命令、通知、状态和中止提示镜像。

存储位置为 `<cwd>/.pi/atom/<sessionId>/web-state.json`，使用同目录临时文件原子替换，单类数据最多 500 项。连接凭证、临时 Prompt、运行中状态和滚动位置不落盘。

### Web 服务设置（网关端口与凭证）

实现位于 [`gateway-client.ts`](gateway-client.ts)（配置读写、会话短码、凭证派生）与 [`index.ts`](index.ts)（`withFixedToken` / `configureWeb` / `rotateWebKey`）。

```ts
readWebConfig(); writeWebConfig({ port?, lanPort?, fixedToken? });
sessionShortCode(sessionId); deriveSessionToken(sessionId);
readTokenKey(); rotateTokenKey(); webTokenKeyPath();
```

- 配置在**用户级** `~/.pi/atom/web/config.json`（`{ port, lanPort, fixedToken }`）而不是浏览器 localStorage：拉起网关的是 pi 进程，读不到页面偏好。环境变量 `PI_ATOM_WEB_PORT` / `PI_ATOM_WEB_LAN_PORT` 优先。
- 快照/patch 字段 `webConfig`：`{ port, lanPort, fixedToken, autoServe, tokenKeyPath, gateway | null }`。除 `gateway` 外都是**强制字段**，服务端每次下发都得给全 —— 少一个不是“那一项不更新”，而是整张快照 / 整条 patch 被协议丢掉。
- Web action `configure_web`：`port` / `lanPort` / `fixedToken` / `autoServe` 至少给一个。端口只影响下一次 `/web` 或 `/web-wlan`；`fixedToken` 变了就原地重启服务换凭证（监听地址、私有端口、网关路由与短码都不动），并在动作响应里带回 `{ token, url }`（调用方此刻仍持旧凭证、已鉴权）；页面自己写回 `sessionStorage["atom-token"]` 并展示新地址。`autoServe`（重启 pi 后自动恢复，默认开）只写用户级配置、不动服务，因此不需要接新凭证也不跳转（下次启动才生效）。
- Web action `rotate_web_key`：换 `token.key`，所有会话的固定凭证整体换代（泄露时的自救）；没开固定凭证时只换密钥、不动服务。
- 固定凭证 = `sha256(本机密钥 + 会话 id)` 的 64 位十六进制（与随机凭证同形状，前端 `TOKEN_RE` 认这个）。密钥不进协议、不进 URL、不写进 `web-state.json`；不掺本机密钥而只用会话 id 派生会让「会话 id 泄露 = 凭证泄露」。

## 生成速度兼容接口

实现位于 [`generation-timings.ts`](generation-timings.ts)（观测与字符估算）与 `index.ts`（结算、快照与落盘）。

```ts
createGenerationTracker(); // { track, settle, finish, reset, streaming, observed }
estimateTokens(text);      // 估算值：CJK 0.7 token/字，其余 3.5 字符/token，按码点计
messageContentTokens(message); // 一条消息里「正文 + 思考」的估算 token
```

口径（与“状态栏那个 tok/s 到底是什么”一一对应）：

- **只算正文与思考**。工具调用参数不计入分子（provider 的 `usage.output` 把它们混在一起拆不出来），生成工具参数的那段时间也不计入分母（工具调用块一出现，前面的正文/思考就结算了）。**Token 总量展示仍用 provider 的权威 `usage`**，与本接口的估算值是两个职责，不得互相替换。
- **时间只算生成过程**。内容块首次在流式事件里出现时开始，它后面出现下一个块（或整条消息结束）时结束，与 `thinking-timings.ts` 同一判据；排队、TTFT、工具执行、压缩、空闲与重试全部不在分母里。**不得**退回「累计 `usage.output` ÷ 会话存活时长」这类会被稀释的算法。
- **没观测到就说没有**。扩展加载前的历史消息无法回溯，因此新会话的首帧 `stats.generation` 全为 0、`liveGeneration` 为 `null`；前端必须显示 `—`，不能编一个数。
- **对外只暴露一个数**。前端的平均输出速度 = `(stats.generation.tokens + liveGeneration.estimatedTokens) / (stats.generation.ms + liveGeneration.elapsedMs)`，即历史累计与当前正在生成的那条消息合算的同一均值；**不得**另做一个只算当前消息的「实时速度」，也不在界面写「约 / ≈ / 估算」这类限定词（用户 2026-09-23 明确要求）。

对外一共三个口子：

| 位置 | 形状 | 说明 |
| --- | --- | --- |
| 快照 / `stats.generation` | `{ tokens, ms, messages }` | 已结算观测的累计量；均值 = `tokens / (ms / 1000)`。`stats` 在协议里是不透明对象，加子字段不需要改 `shared/protocol.*` |
| 快照 / patch 的 `liveGeneration` | `null` 或 `{ startedAt, elapsedMs, estimatedTokens }` | 当前这条正在生成的消息的观测；前端把它**加到累计量上算同一个均值**（不是单独一个实时值）；随 `liveMessage` 的 patch 发布（`message_update` 不刷 stats），没正文/思考时为 `null`；**协议校验在 `shared/protocol.ts` 与 `.js` 两份里都要写** |
| `web-state.json` 的 `generation` | `{ tokens, ms, messages }` | 累计量落盘（只存累计，没有逐条明细的消费方），重启后均值不归零 |

结算点：`message_end`（正常）、`agent_settled`（中止 / 强杀兜底，用最后一次流式刷新到的估算）、`session_start` 与 `session_switch` 族、abort 动作（后三者只清空跟踪器，不动累计量）。

## 上下文压缩兼容接口

`/compact` 与 Pi 自己的自动压缩都通过宿主事件暴露；Web 需要三样东西：命令记录上的执行状态、压缩条目本身、协议字段。

- 事件：`pi.on("session_before_compact" | "session_compact" | "session_compact_failed")`。这些是扩展面事件（`session_*`），不是 TUI 内部的 `compaction_start/end`。
- 命令记录（`displayRecords`，落盘 `web-state.json`）：**记录 id 在 `record.id` 上，不在 `record.message` 上**（消息 id 在序列化时才由 `withId` 写进去）。Web 执行 `/compact` 时把本次压缩绑到该记录：
  - 运行态 `compaction: { startedAt }` **只在 `displayMessages()` 的序列化输出上叠加**，不写进记录 —— 进程中途退出、`/reload` 或刷新都不会留下一个转不完的计时；
  - `session_compact` 成功时把 `{ startedAt, endedAt }` 写进 `record.message.compaction` 并落盘；`session_compact_failed` 不写，失败提示由 `context.compact({ onError })` 的 `ui.notify` 承担。
  - 落盘的完成态在**序列化时搬家**：若当前 branch 存在配对（`entry.parentId === record.anchor`）的 `type:"compaction"` 条目，`displayMessages()` 把 `compaction:{startedAt, endedAt}` 从命令记录移交给那条 `compactionSummary`（命令记录里删掉该字段，且不带 `undefined` 键），前端渲染在压缩块**下方**；没有配对条目时留在命令记录上，完成行不会丢失。运行态（只有 `startedAt`）始终只叠加在命令记录上、不落盘。
- 压缩条目：branch 里的 `type:"compaction"` entry（宿主 `CompactionEntry`：`summary` / `tokensBefore` / `retainedTail` …）被转成 `role:"compactionSummary"` 的 Web 消息（带 `tokensBefore`，配对时另带 `compaction`），前端渲染为「压缩」可折叠块（其下可跟一行完成状态）。它是纯派生输出，不进 `displayRecords`、不落盘。自动压缩（没有 `/compact` 命令记录）因此只有压缩块、没有完成行。**分组分流**：自动压缩在前端属于 `PROCESS_ROLES`（`turnGroups.js`），不切断轮次分组也不触发自动折叠，并在轮次标题**末尾**计入「压缩`n`」（一个连续任务不会因压缩被拆成两轮）；**手动 `/compact` 不属于中间过程**（用户 2026-09-23 更正）—— 它切断分组、单独渲染，不计入标题，识别靠下面那条 `compactionReason`。
- 触发原因（`compactionReason`）：宿主只在 `session_compact` **事件**上给 `reason: "manual" | "threshold" | "overflow"`，**落盘的 `CompactionEntry` 没有这个字段**。而前端要靠它分流：手动 `/compact` 是用户显式按下的页面边界（不进轮次分组、不计入轮次标题），自动压缩才是本轮的一步。所以扩展按 `compactionEntry.id` 把原因记进 `web-state.json` 的 `compactionReasons`（`session-state.ts` 的 `reasonMap()`，只放行三个枚举值、上限 500），`displayMessages()` 序列化时下发 `compactionReason`。兼容路径：扩展当时未加载的旧条目没有记录，若它与一条**已完成的 `/compact` 命令记录**配对（即 `compaction` 完成行从命令记录搬到块上的情形）就算 `manual`；两者都拿不到时**不下发该字段**，前端保持旧行为（归进分组）。
- 前端分流（`turnGroups.js`）：`isManualCompactionMessage()` = `role === "compactionSummary" && compactionReason === "manual"`，`isProcessMessage()` 直接排除它，`isCompactionMessage()`（计入轮次标题）只认自动压缩。
- 协议（`shared/protocol.ts` / `.js` 双端同步校验）：`compactionSummary.tokensBefore`（可选、非负数字），`compactionSummary.compactionReason`（可选，`manual` / `threshold` / `overflow`），以及任意消息项上的 `compaction: { startedAt, endedAt? }`（`endedAt >= startedAt`，`compactionField()` 同时服务命令记录与压缩条目）。客户端 `LiveFeed` 也依赖它：消息里存在「带 `compaction` 且无 `endedAt` 的命令消息」时，底部 live 区不再显示压缩状态（状态只出现在命令横线下方）。

## 上下文用量兼容接口

来源是宿主扩展面的 `ctx.getContextUsage()`（返回 `{ tokens, contextWindow, percent } | undefined`）：pi 用最近一次 LLM 用量 + 之后新增内容的估算算出当前占用，**`tokens` / `percent` 可以是 `null`**（刚压缩完、还没有新的 LLM 回复时就是未知）。

- 扩展侧 `contextUsage()`（`index.ts`）归一化成协议形状后发布：`getContextUsage` 不存在（旧运行时）或 `contextWindow <= 0` → 整体 `null`；数值取整、`percent` 裁到 `0..100`。**不得把 `null` 当成 0**：`Number(null) === 0` 会把「未知」画成 0%（已踩过，`test/bridge.test.js` 有用例覆盖）。
- 发布时机：**跟 `stats` 同一个刷新通道** —— `publish(ctx, …, { stats: true })` 在定时器里除 `refreshed.stats` 外还写 `refreshed.contextUsage`（上下文只随 LLM 用量变化，与 Token 统计同一时机），快照里带全量。不要挂在 `message_update` 上：流式期间没有新用量，只会白推字节。
- 协议（`shared/protocol.ts` / `.js` 双端同步）：`contextUsage` 是 `null` 或 `{ tokens: number | null, contextWindow: number, percent: number | null }`；`contextWindow ∈ (0, 1e9]`、`percent ∈ [0, 100]`。
- 前端：存在 `session.contextUsage`；`contextUsageView()`（`web/components/status/format.js`，纯函数）算出 `ratio` 与三档 `level`（`unknown` 不画弧 / `ok` 灰 / `warn` ≥60% 橙 / `danger` ≥85% 红，与全站「只有三种状态色」一致）；`ContextRing.js` 在模型名左侧画 SVG 环（半径 7、线宽 3、`stroke-dasharray` = 周长 × ratio，`transform: rotate(-90 9 9)` 使用量从 12 点顺时针），点击弹层（`composer.popover === "context"`，与模型/思考级别选择器互斥、与状态栏弹层同样由 `AppShell` 的点击外部收起）展示「当前上下文 / 最大上下文 / 上下文占比」，明细行**复用 `DetailRows`（`kind: "context"`）**；「压缩上下文」按钮发的是已有的 `send` action（文本 `/compact`、`mode: "followUp"`），**不新造 action 类型**；本轮正在生成或已在压缩时禁用。



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

## 工作区文件与 Git RPC

### 通用侧栏容器与模块登记

`web/components/workspace/SidePanelHost.js` 是通用侧栏宿主，`panel-registry.js` 导出 `SIDE_PANEL_REGISTRY`、`openSidePanel(id, payload)` 与 `closeSidePanel(id)`。registry 条目形状为 `{ id, label, load }`，其中 `load` 返回懒加载组件；宿主只接受已登记 id，通过 `atom-open-side-panel` 事件接收 `{ id, payload }`，向当前组件传入 `token/sessionId/payload/active/onClose/onError`。宿主基于 registry 渲染内容 tab，props 中的 `active` 表示当前可见项；当前 registry 只有 workspace 一项。关闭只收起侧栏并将内容设为不活跃，不触发草稿确认；组件保持挂载。新增侧栏内容应登记新条目并实现该组件 props 合约；不要在宿主内硬编码内容类型。

当前登记内容只有 `workspace`（label「工作区」）。workspace 内部实现由 `FileTree`、`FileEditor`、`GitPanel`、`DiffView`、`ConflictEditor` 等组件构成；它们不是独立 registry 项。终端浏览器没有实现或登记。侧栏宽度可鼠标拖动，也可聚焦分隔条用左右方向键每次调整 16px、Home/End 跳到宽度边界，并保存在 `localStorage` 的 `atom-side-panel-width`。收起侧栏会隐藏 workspace 内容并令其 `active=false`，组件保持挂载；再次打开可保留内部状态。面板子模块可按需使用独立 API，但通用宿主本身不定义业务 RPC。

实现位于 `extensions/workspace.ts`、`workspace-files.ts`、`workspace-git.ts`，浏览器调用封装在 `web/api/workspace.js`。它是独立于会话消息 action 与 snapshot/patch 的 JSON RPC，不读取消息正文，也不改变会话树；由同一个 HTTP 服务校验 `Authorization: Bearer <token>`。请求体为 `{ sessionId, op, ...params }`，sessionId 必须与 workspace 服务通过 `workspaceContext()` 取得的当前 sessionId 一致。`extensions/index.ts` 注入的 `workspaceContext()` 每次只返回轻量 `{sessionId,cwd}`；workspace RPC 用它做会话校验，并在 sessionId/cwd 变化时重新初始化工作根，不调用完整会话快照或重算会话历史。服务端返回 JSON；路径/冲突错误带 HTTP 状态（常见 403 越界、409 会话/版本过期、413 超限）。

| `op` | 参数 | 用途 |
|---|---|---|
| `info` | 无 | 返回 cwd、repositoryRoot、roots、workspaceId、limits、capabilities |
| `list` | `root?`, `path?`, `hidden?`, `ignored?` | 列目录项 |
| `search` | 上述字段 + `query` | 按名称递归查找 |
| `read` | `root?`, `path`, `offset?`, `limit?` | 读文件；大文本分页 |
| `save` | `root?`, `path`, `text`, `version`, `force?` | 保存可编辑文本 |
| `create` | `root?`, `path`, `directory?`, `text?` | 新建文件或目录 |
| `rename` | `root?`, `path`, `target` | 重命名 |
| `delete` | `root?`, `path`, `confirmed:true` | 删除 |
| `download` | `root?`, `path` | 返回 `{name,mime,data}`，data 为 base64 |
| `watch` | `targets:[{root?,path}]` | 创建监听并返回 `watchId` |
| `unwatch` | `watchId` | 结束监听 |
| `git_status` | 无 | 仓库状态及并发 revision |
| `git_diff` | `path`, `kind:staged\|worktree\|commit`, `commit?` | 差异与状态 |
| `git_history` | `limit?`, `offset?`, `cursor?` | 提交历史 |
| `git_commit_files` | `commit` | 指定提交的文件列表 |
| `git_conflict` | `path` | 读取 ours/theirs/result 与冲突 version |
| `git_resolve` | `path`, `version`, `side?:ours\|theirs` 或 `text` | 解决并暂存冲突 |
| `git_write` | `command`, `revision` 及命令专属字段 | 执行 Git 写操作，返回新状态 |

文件操作的返回对象为 `list/search: {entries,truncated}`、`read: {path,text?,offset,nextOffset?,eof,version,bytes,editable,binary,image?,reason?}`。不超过 2 MiB 的普通 UTF-8 文本一次读完，`version` 为文件内容 SHA-256；更大文本按 `offset`（从 1 开始的行号）分页，默认 `limit=500`，单页上限 2,000 行/512 KiB，`version` 为 `size:mtime:inode` stat 指纹。客户端下一页使用 `nextOffset`。仅扩展名为 PNG/JPG/JPEG/GIF/WebP/AVIF 且文件 ≤16 MiB 的图片返回 base64 data URL；SVG 不在图片白名单内，不以内嵌方式执行。二进制与超大文本均不可编辑。下载最大 64 MiB。文件写 RPC `save/create/rename/delete` 由文件服务自己的 Promise 队列串行；读取与枚举不经过该队列。

`root` 只能是 `cwd`（Pi 当前工作目录）或 `repo`（从 cwd 探测的仓库根）；无可用仓库时 repo 为空。文件路径限定在所选根内，禁止 `.git`、越界符号链接与根目录删除/移动。目录枚举最多 10,000 个节点/1,000 条结果，监听最多 64 个目标。忽略与隐藏条目默认不显示。

文本编辑仅支持不超过 2 MiB 的 UTF-8 普通文件；更大文件以只读分页返回（每页最多 512 KiB、2,000 行），保存内容也限 2 MiB。`save` 必须携带 `version`，版本变化返回 409；只有显式 `force:true` 才覆盖。前端草稿是 `WorkspacePanel` 运行期间的 Vue 内存状态：关闭文件标签、切换或重载文件时按对应操作提示处理；侧栏收起只隐藏组件，不清除草稿。页面刷新或组件卸载后草稿不保留；页面刷新会通过 beforeunload 提示未保存草稿。侧栏宽度另存为 `atom-side-panel-width`，不与文件草稿混用。

`git_write` 支持 `stage`、`unstage`、`discard`、`delete`、`commit`、`branch_create`、`switch`、`fetch`、`pull`、`push`、`stash_create/apply/pop/drop`、`merge_continue/abort`、`rebase_continue/abort`。参数按命令可含 `paths`、`message`、`branch`、`remote`、`strategy`、`stash`、`confirmed:true`。所有 `git_write` 携带 `revision`，Git 服务在自己的串行队列中再次核对状态；不匹配返回 409。`git_resolve` 不带仓库 revision，但在同一 Git 写队列中用冲突内容 `version` 做并发校验。丢弃、删除未跟踪文件、提交、切换分支、pull/push、所有 stash 写操作与继续/中止 merge/rebase 必须显式确认。`fetch`、stage/unstage、创建分支不要求该确认字段。`git_diff` 检测到 `GIT binary patch` 时会截断二进制 payload，追加可读提示并返回 `binary:true`。

监听通过 `GET /api/workspace/events?sessionId=…&watchId=…` 建立 SSE，同样要带 Bearer 凭证。watch 创建后 30 秒内须接通；ready 后推送 `invalidate`，并每 15 秒发送心跳。每服务最多 32 个监听连接；客户端结束流即清理订阅。workspace 服务随会话切换或 HTTP 服务关闭而释放。`POST /api/workspace` 的 JSON body 上限 16 MiB，用于容纳 2 MiB 文本经 JSON 转义后的最坏膨胀；服务仍按实际 UTF-8 内容限制 `save.text` 为 2 MiB。

当前 `WorkspacePanel` 使用 `info` 获取两个工作根：`cwd` 为宿主启动时工作目录，`repo` 为从 cwd 探测到的 Git 仓库根；不存在仓库时 repo 相关文件根不可用，Git 面板报告无可用仓库。文件视图右侧仅展示最后点击的文件作为快捷预览，点击「在标签中打开」才创建顶部独立文件标签；顶部「目录」同样可关闭，关闭全部标签收起侧栏，缓存已读页与每个路径的草稿；大文件按行翻页，页数累计展示并保持 `nextOffset`。切换文件、关闭标签或重载文件时按操作处理未保存草稿；收起侧栏保留草稿，页面刷新通过 beforeunload 提示未保存草稿。保存冲突 409 后可选择覆盖。Git 状态变更由 watcher 事件触发刷新，前端每 5 秒轮询 Git 状态。

- `shared/protocol.ts` 是扩展端协议校验器，`shared/protocol.js` 是浏览器端内容同步副本。
- snapshot/patch 使用 `schemaVersion: 1`，事件带 `streamId`、`sequence` 和 `sessionId`。
- action 必须携带当前 `sessionId`；会话已经切换时拒绝执行。
- 用户消息可选 `delivery: "steer"`（引导送达，目前只有这一个取值），由服务端从 Prompt 队列推定。
- 时间映射（`toolTimings` / `thinkingTimings`）允许 `durationMs` 缺席 = 仍在进行：流式中的思考块要先把 `startedAt` 发给浏览器实时计时，结算值随后端覆盖。
- 兼容层依赖的 Pi 内部入口目前包括 `AgentSession._bindExtensionCore()`、`AgentSession.agent.*Queue.messages` 和 `ExtensionRunner.getEntryRenderer()`。
- 升级 `@earendil-works/pi-coding-agent` 后，必须重新验证这些入口；不可用时应保留正式 API 回退或通用 UI，不能静默产生错误数据。

## 新增兼容接口的要求

1. 先确认 Pi 正式 API 是否已经提供同等能力。
2. 把通用 Pi 兼容放在 `extensions/`；第三方 package 专用兼容放在 `extensions/packages/<package-id>/`。
3. 为能力检测、正常路径、缺失/失败回退和 `/reload` 防重复安装编写测试。
4. 为传到浏览器的结构补齐 `shared/protocol.ts` 与 `.js` 校验。
5. 更新本文、README、CHANGELOG 和必要的专项文档。
6. 明确标注依赖的 Pi 版本与内部入口，避免把兼容层 API 描述为 Pi 官方 API。

- 工作面板补充：侧栏宿主布局样式 `side-panel.css` 与工作区内容样式 `workspace.css` 分离，注册项可指定自己的惰性样式。Diff 标签保留不同路径/暂存状态/提交的差异，支持切换和关闭；统一视图的增删行分别展示，模式、重命名与二进制摘要保留。文件变化通知附带 root/path，客户端按目标刷新打开文件；未改变版本不替换已读分页。切换会话时隔离请求/监听，旧会话未保存草稿仅保留在页面内存，切回可以恢复；刷新前仍提示全部未保存草稿。

侧栏内容可发送 tabs-change 事件，载荷为 {tabs:[{id,label}],active}，并通过组件 expose 提供 selectTab(id)、closeTab(id)；宿主用该合约展示和操作内容内的顶部标签。工作区目录 id 为 directory，独立文件 id 为 file:路径；收起与关闭标签是不同操作，关闭未保存的文件标签仍提示保存、放弃或取消。

侧栏展开时右上角使用侧栏图标收起，开合过渡为 180ms（减少动态效果时禁用）。折叠保留页面，刷新按会话恢复开合、标签、当前文件、快捷预览和目录/Git 视图；浏览器仅保存页面路径与布局，不保存文件内容、凭证或未保存草稿。
