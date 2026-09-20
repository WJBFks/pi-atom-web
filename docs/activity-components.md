# 活动组件架构与接入规范

活动组件位于输入卡上方，用一排类似浏览器标签页的 tab 汇集当前会话中需要用户关注或操作的临时界面。当前实现由 `web/components/composer/ActivityBar.js` 统一编排，承载两类内容：

- 未完成的 Pi 扩展交互请求；
- 当前非空的 Prompt 队列。

它是 Web UI 内部的组合层，不是 Pi 系统 API，也不是第三方 package 可以直接调用的动态组件注册 API。第三方扩展应通过已有的 dialog 桥接或 package 兼容层提供结构化数据，再由活动栏映射为 tab 和内容面板。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `web/components/composer/ActivityBar.js` | 生成、排序和渲染 tab，管理展开、切换、折叠、焦点与自动展开 |
| `web/components/composer/ComposerDock.js` | 提供 `.dock-overlay` 浮层宿主，显示阻塞提示并禁止被阻塞会话继续提交 |
| `web/components/dialogs/RequestDock.js` | 将扩展请求分发给 package 专用界面或通用请求界面 |
| `web/components/composer/PromptQueuePanel.js` | 展示、添加和删除 Steering / Follow-up 队列项 |
| `web/stores/dialogs.js` | 保存请求、计算阻塞活动和阻塞提示文案 |
| `web/stores/dialog-requests.js` | 提交扩展请求响应，处理重复提交、取消、会话切换和 package 草稿清理 |
| `web/style.css` | tab、面板、浮层、滚动、动画、深色主题与窄屏样式 |

## 内部 tab 模型

活动栏先把不同来源归一成内部 tab。当前实际使用的字段如下：

```js
{
  id: string,                // 当前活动生命周期内稳定且唯一
  label: string,             // tab 显示名称
  icon: string,              // web/icons.js 中的图标名
  priority: number,          // 越大越靠左
  arrivedAt: number,         // 同优先级时越早越靠左
  tone: {
    color: string,
    background: string,
    border: string,
  },
  autoOpen?: boolean,        // false 表示出现时不自动展开
  request?: DialogRequest,   // 扩展请求内容
  queue?: true,              // Prompt 队列类型标记
}
```

`sortActivityTabs()` 按 `priority` 降序排列，再按 `arrivedAt` 升序排列。缺失或非有限数值按 `0` 处理；排序返回新数组，不修改来源数据。

当前优先级：

| 类型 | 优先级 | 出现条件 | 自动展开 |
| --- | ---: | --- | --- |
| 扩展请求 | 1000 | 请求尚未完成 | 是，受用户折叠状态约束 |
| Prompt 队列 | 500 | Steering 或 Follow-up 总数大于 0 | 新增或修改时 |

Prompt 队列的 tab 名称实时显示 `消息队列 N`；总数为 0 时不渲染，即使模型正在生成也不会显示“消息队列 0”。普通 Composer 提交的 Prompt 默认进入 Follow-up 排队。活动面板不提供重复标题或第二个输入区，只管理已有项：面板内始终保留上方「引导队列」和下方「排队队列」，空分组显示“暂无”，引导队列使用浅色背景；可把排队项转换为 Steering 以引导当前轮，也可转回排队，并支持编辑文字和图片或删除。图片以可点击预览的缩略图显示；编辑状态可选择、粘贴、拖入和移除图片，纯图片消息也可保存。新增、编辑或跨队列转换会自动展开消息队列，并让新增或修改后的具体消息边框闪烁两次；分组外框不闪烁，纯删除和 Pi 正常消费队列不触发。

## 扩展请求映射

每个未完成的扩展请求各占一个 tab。默认外观为：

```js
{
  label: request.title || `扩展请求 · ${request.kind}`,
  icon: "box",
  tone: EXTENSION_REQUEST_TONE,
}
```

`PACKAGE_ACTIVITY_LOOK` 可以按 `packageId` 改写 tab 名称、图标和 tone。目前 `@juicesharp/rpiv-ask-user-question` 显示为“提问”、使用 `help` 图标和黄色 tone。

package 专用适配仍应放在 `web/packages/<package-name>/`，由请求 registry 和 `RequestView` 按需加载。`PACKAGE_ACTIVITY_LOOK` 只控制活动栏外观，不能代替请求载荷校验、应答格式转换或专用表单实现。

## 展开状态与生命周期

活动栏维护三个不同状态：

- `focused`：键盘焦点所在 tab；
- `expanded`：当前展示内容的 tab；
- `closing`：正在播放 160ms 退场动画的 tab。

焦点和展开状态必须分离。折叠态按方向键只移动焦点；已有面板展开时，方向键同时切换内容。点击 tab 会展开或切换，重复点击已展开 tab不会折叠。折叠只能通过最小化按钮或 `Esc`。

扩展请求首次出现时，活动栏会自动展开尚未自动展示过的第一个请求。用户手动折叠后，不再因普通扩展请求自动打断用户；所有活动消失后会清空这份临时选择状态。Prompt 队列采用变化驱动的独立规则：新增或修改队列项时，即使用户此前手动折叠，也会重新展开消息队列；删除与正常消费不展开。

非当前面板不能卸载。它们保留在 `.activity-panel-host.is-collapsed` 中，以 `height:0; overflow:hidden` 隐藏。这样切换 tab 或折叠后，问卷草稿、选项状态和 xterm 实例不会丢失。共享 tab 行只渲染一份，禁止在每个隐藏面板中复制 tab 行。

## 键盘与 ARIA

tab 行使用 `role="tablist"`，每个按钮使用 `role="tab"`、`aria-selected` 和 `aria-controls`；展开面板使用 `role="tabpanel"` 与 `aria-labelledby`。

键盘规则：

- `ArrowLeft` / `ArrowRight`：循环移动；
- `Home` / `End`：跳到首项或末项；
- `Escape`：折叠当前面板；
- `disabled` 的 tab 不参与移动。

tab 从折叠行移动到面板标题行时 DOM 节点会重建，因此状态更新后必须通过 `nextTick()` 或微任务重新聚焦对应的 `[data-activity-tab]` 节点。

## 阻塞活动

扩展请求默认阻塞会话；仅当请求明确带有 `blocking:false` 时才不阻塞。Prompt 队列本身不阻塞。

`web/stores/dialogs.js` 是阻塞判定的唯一来源：

```js
blockingActivities(requests)
blockedMessageParts(requests, look)
blockedMessage(requests, look)
```

存在阻塞活动时，Composer 禁止提交 prompt 和点击发送，并在输入区显示“会话已被 `活动名` 阻塞，请先处理”。活动名必须与 tab 名称一致，因此 `ActivityBar` 会把 `activityLook()` 注入 dialogs store。

扩展请求应答由 `useDialogRequests()` 统一处理：同一请求不能重复提交；请求携带当前 `sessionId`；断线时拒绝提交；会话切换、请求消失或组件卸载时取消仍在进行的 HTTP 请求；成功后清理对应 package 的临时草稿状态。

## 浮层与滚动

`.dock-overlay` 绝对定位在输入卡上方，不参与 `.compose-wrap` 的高度计算。因此活动面板展开或折叠不会改变 `--compose-height`、消息区底部留白或当前滚动位置。

活动栏左右边界由以下变量共同决定：

```css
--activity-inset: 30px;
--activity-margin: calc(var(--dock-pad, 28px) + var(--activity-inset));
```

展开面板内容高度上限为 `40dvh`。具体请求组件负责自己的内部可滚动区域；活动面板通过 flex 的 `min-height:0` 把有界高度传给内容。

浮层安装捕获阶段、非 passive 的 `wheel` 监听器。光标下的内部滚动容器在当前方向仍可滚动时放行；到达边界或没有内部滚动容器时阻止事件，避免滚轮穿透并滚动主会话。

## 视觉规则

每个活动提供 `tone.color/background/border`，由组件以内联 CSS 变量传入。CSS 遵循三态：

- 未激活：页面默认背景、文字和边框；
- 未激活 hover：默认背景加活动 tone 的文字颜色；
- 激活：使用活动 tone 的背景、文字和边框。

面板外框、tab 行分割线和内容区边框统一使用中性的 `--border`。tone 只用于 tab，避免同一条边在内容区开始处突然变色。深色主题通过 `color-mix()` 降低浅色 tone 背景亮度并提高文字对比度。

展开态所有 tab 共享面板顶部的一行，最小化按钮贴右。当前 tab 用自己的伪元素盖住对应的一段下分割线，使其与内容区连成一体。每个 tab 保留完整左右边框，不通过负 margin 合并边线。

进场动画为 180ms，退场为 160ms，tab 行进场为 140ms。`prefers-reduced-motion: reduce` 下禁用这些动画。退场期间面板禁止指针事件。

## 新增活动类型

当前没有活动注册表。新增一种核心活动时需要同时完成：

1. 在 `ActivityBar.tabs()` 中根据 Pinia 状态生成稳定的 tab；
2. 为它分配明确的优先级、tone、图标和 `autoOpen` 策略；
3. 在 `panelBody()` 中渲染对应组件；
4. 明确它是否阻塞输入；若阻塞，应把判定集中到相应 store，不能只在视图里禁用按钮；
5. 保持隐藏面板挂载，并在会话切换或活动结束时清理网络请求、计时器、观察器和 package 草稿；
6. 增加纯函数测试和浏览器交互测试。

若活动来自第三方 Pi package，应优先复用通用 dialog 桥接。只有载荷或交互语义超出通用请求时，才在 `extensions/packages/` 与 `web/packages/` 增加按需兼容；不要让第三方 package 直接向浏览器注入 Vue 组件、HTML 或脚本。

## 验证清单

- 多个活动按优先级和到达顺序稳定排列；
- 新活动的 `id` 在其生命周期内唯一且稳定；
- 普通扩展请求的自动展开不会覆盖用户手动折叠；Prompt 队列新增或修改属于明确例外；
- 切换和折叠后表单草稿仍存在；
- 键盘循环、Home/End、Escape 和焦点恢复正确；
- 阻塞提示名称与 tab 名称一致，发送入口全部被禁用；
- 内部滚动到边界后不会带动主会话；
- 展开/折叠不改变消息区滚动位置和 dock 高度；
- 浅色、深色、窄屏和 reduced-motion 均可用；
- package 专用代码保持按需加载，未安装对应 package 时静默无副作用。
