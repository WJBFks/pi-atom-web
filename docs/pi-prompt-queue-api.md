# Pi Prompt 队列与引导 API

本文基于 `@earendil-works/pi-coding-agent 0.85.1`，汇总 Pi 系统层、RPC、扩展层，以及 pi-atom-web 兼容层暴露的 Prompt 排队与引导能力。

## 概念

Pi 有两类用户 Prompt 队列：

- **Steering**：尽快送入当前运行中的 agent，用于修正方向。它会在下一次适合接收用户消息的边界进入上下文；仍有 steering 时，agent 可以继续当前轮。
- **Follow-up**：等待当前 agent 完成工具调用和 steering 后再执行，通常形成后续一轮。

Pi 设置中的 `steeringMode` 与 `followUpMode` 可取：

- `all`：一次消费当前类别的全部排队消息。
- `one-at-a-time`：每次只消费一条。

队列只存在于进程内存，不属于 branch 会话记录；消息真正进入模型轮次后才成为会话消息。

## 系统 API：`AgentSession`

`AgentSession` 是功能最完整的系统层 API。

### 添加消息

```ts
await session.steer(text, images?);
await session.followUp(text, images?);
```

两者会展开技能命令和 Prompt 模板；扩展命令不能排队。

也可以调用统一入口：

```ts
await session.prompt(text, {
  images,
  streamingBehavior: "steer" | "followUp",
});
```

`sendUserMessage()` 是面向扩展语义的入口：

```ts
await session.sendUserMessage(content, {
  deliverAs: "steer" | "followUp",
  expandPromptTemplates: true,
});
```

自定义消息还支持不立即触发用户轮次的 `nextTurn`：

```ts
await session.sendCustomMessage(message, {
  triggerTurn: true,
  deliverAs: "steer" | "followUp" | "nextTurn",
});
```

### 查看队列

```ts
session.pendingMessageCount;
session.getSteeringMessages(); // readonly string[]
session.getFollowUpMessages(); // readonly string[]
```

### 监听队列

```ts
const unsubscribe = session.subscribe((event) => {
  if (event.type !== "queue_update") return;
  console.log(event.steering, event.followUp);
});
```

事件结构：

```ts
{
  type: "queue_update";
  steering: readonly string[];
  followUp: readonly string[];
}
```

### 清空队列

```ts
const removed = session.clearQueue();
// { steering: string[], followUp: string[] }
```

Pi 核心没有按 ID 删除、替换或移动单条消息的正式 API，也没有为队列项分配稳定 ID。

### 消费模式

```ts
session.setSteeringMode("all" | "one-at-a-time");
session.setFollowUpMode("all" | "one-at-a-time");

session.steeringMode;
session.followUpMode;
```

对应持久化设置字段为 `steeringMode` 和 `followUpMode`。

## RPC API

`RpcClient` 提供：

```ts
await client.steer(message, images?);
await client.followUp(message, images?);
await client.clearQueue();
await client.setSteeringMode(mode);
await client.setFollowUpMode(mode);
```

RPC 命令名分别是：

- `steer`
- `follow_up`
- `clear_queue`
- `set_steering_mode`
- `set_follow_up_mode`

`client.onEvent()` 可以收到 `queue_update`。`get_state` 只返回 `pendingMessageCount`，不会返回队列正文；正文应从 `queue_update` 维护。

## 正式扩展 API

扩展入口对象支持：

```ts
pi.sendUserMessage(content, {
  deliverAs: "steer" | "followUp",
  expandPromptTemplates?: boolean,
});

pi.sendMessage(customMessage, {
  triggerTurn?: boolean,
  deliverAs: "steer" | "followUp" | "nextTurn",
});
```

事件或命令 handler 收到的 `ExtensionContext` 只提供：

```ts
ctx.hasPendingMessages(): boolean;
```

正式扩展 API 当前没有提供：

- 队列正文和数量；
- `queue_update` 扩展事件；
- `clearQueue()`；
- 单条删除、修改或排序。

## TUI 行为

TUI 会分别显示 `Steering:` 和 `Follow-up:`。`app.message.dequeue` 的“编辑全部队列”并非原地修改：它调用 `clearQueue()`，把全部文本拼回编辑器，用户修改后重新发送。

TUI 在压缩期间还有独立的 `compactionQueuedMessages`。它由 Interactive Mode 管理，不属于 `AgentSession.getSteeringMessages()` / `getFollowUpMessages()`，普通扩展无法读取。

## pi-atom-web 兼容 API

pi-atom-web 在 `extensions/prompt-queue.ts` 安装运行时观察器，把当前 `AgentSession` 与只读的 `ctx.sessionManager` 关联。该兼容层只向已鉴权的 Web action 暴露有界数据，不把 `AgentSession` 实例发到浏览器。

### 服务端状态字段

snapshot 和 patch 可包含：

```ts
interface PromptQueueItem {
  id: string;
  kind: "steer" | "followUp";
  index: number;
  text: string;
}

interface PromptQueueSnapshot {
  revision: number;
  count: number;
  steering: PromptQueueItem[];
  followUp: PromptQueueItem[];
}
```

`queue_update` 到达后，服务端实时发布新的 `promptQueue` patch。Web 活动组件栏显示总数，展开后分别显示两个队列。

### 添加 Steering / Follow-up

请求：

```json
{
  "type": "queue_add",
  "sessionId": "当前会话 ID",
  "kind": "steer",
  "text": "请先检查失败日志"
}
```

`kind` 可为 `steer` 或 `followUp`。成功响应：

```json
{
  "ok": true,
  "promptQueue": {
    "revision": 5,
    "count": 2,
    "steering": [],
    "followUp": []
  }
}
```

实际状态也会通过 SSE `promptQueue` patch 推送，响应中的快照主要用于调用方确认。

Web 普通 Composer 新增的 Prompt 固定使用 `followUp`。活动组件不再提供额外输入区，只管理已经排队或正在引导的消息；需要影响当前轮时，可把 Follow-up 转换为 `steer`。

普通 Composer 提交通过兼容层的 `submit()` 等待 `AgentSession.prompt()` 的 `preflightResult`。HTTP action 在 Pi 确认消息已经启动或进入 Follow-up 后返回，但不会等待整轮模型完成。不能直接把 `pi.sendUserMessage()` 的同步返回当作已完成 preflight：正式扩展 API 是 fire-and-forget，连续提交时会留下两个请求同时进入底层 agent 的竞态窗口。

### 编辑或转换单条

`queue_update_item` 同时负责修改文本，以及在 Follow-up（排队）和 Steering（引导）间转换：

```json
{
  "type": "queue_update_item",
  "sessionId": "当前会话 ID",
  "id": "followUp:0:1abcxyz",
  "revision": 4,
  "kind": "steer",
  "text": "改写后立即引导当前轮"
}
```

成功响应包含修改前、修改后的完整条目和最终队列：

```json
{
  "ok": true,
  "previous": {
    "id": "followUp:0:1abcxyz",
    "kind": "followUp",
    "index": 0,
    "text": "原排队内容"
  },
  "updated": {
    "id": "steer:0:4defuvw",
    "kind": "steer",
    "index": 0,
    "text": "改写后立即引导当前轮"
  },
  "queue": {
    "revision": 7,
    "count": 1,
    "steering": [
      {
        "id": "steer:0:4defuvw",
        "kind": "steer",
        "index": 0,
        "text": "改写后立即引导当前轮"
      }
    ],
    "followUp": []
  }
}
```

同类别编辑会保留该项在类别内的位置；跨类别转换会把它追加到目标类别末尾。请求中的 `text` 去除首尾空白后不能为空。

### 删除单条

请求必须带客户端最后看到的 `revision`：

```json
{
  "type": "queue_remove",
  "sessionId": "当前会话 ID",
  "id": "followUp:0:1abcxyz",
  "revision": 4
}
```

成功响应包含被删除项的完整可用信息，以及删除后的完整队列：

```json
{
  "ok": true,
  "removed": {
    "id": "followUp:0:1abcxyz",
    "kind": "followUp",
    "index": 0,
    "text": "完成后总结"
  },
  "queue": {
    "revision": 7,
    "count": 1,
    "steering": [],
    "followUp": []
  }
}
```

Pi 没有单条编辑、移动或删除原语，因此兼容层会执行“校验 revision → 清空全部 → 应用修改 → 按类别和顺序重新入队”。操作期间收到的中间 `queue_update` 不会推送给 Web，只发布最终快照。

清空与重新入队不是系统事务。如果重建中某条消息失败，action 会返回错误，同时兼容层仍会立即发布 Pi 当前的真实队列，避免浏览器保留删除前的陈旧状态。

如果 revision 已变化，服务端返回错误，不会删除任何消息。这样可以避免模型刚好消费队首时误删下一条。

## 限制与兼容性

- 队列项 ID 由类别、当前下标和文本摘要派生，只在对应 revision 下有效；它不是 Pi 的持久 ID。
- Pi 的查看和清空 API只返回文本。单条删除重建队列时无法保留原消息的图片附件，因此当前 Web 队列面板只允许添加纯文本。
- 单条删除不覆盖 Interactive Mode 独立维护的压缩期队列。
- 运行时捕获依赖 `AgentSession._bindExtensionCore()`。模块使用 `Symbol.for()` 防止 `/reload` 重复包装，并在不支持该内部接口时保持 Web 其他能力可用。
- Pi 升级后应重新核对 `AgentSession` 的队列方法、事件结构和扩展绑定时机。
