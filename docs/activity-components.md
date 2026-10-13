# 活动组件架构与接入规范

活动组件位于输入卡上方，用一组类似浏览器标签页的 tab 汇集当前会话中需要用户关注或操作的临时界面。**折叠态是一排占满内容列宽度的长条、纵向堆叠（高优先级在最上方）；展开态则整行升到大框顶部并回到横向**。当前实现由 `web/components/composer/ActivityBar.js` 统一编排，承载两类内容：
- 未完成的 Pi 扩展交互请求；
- Prompt 队列的每条待处理消息（折叠态各占一条长条；展开态顶部是一个「消息队列 N」面板 tab）。

它是 Web UI 内部的组合层，不是 Pi 系统 API，也不是第三方 package 可以直接调用的动态组件注册 API。第三方扩展应通过已有的 dialog 桥接或 package 兼容层提供结构化数据，再由活动栏映射为 tab 和内容面板。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `web/components/composer/ActivityBar.js` | 生成、排序和渲染 tab，管理展开、切换、折叠、焦点与自动展开 |
| `web/components/composer/ComposerDock.js` | 提供 `.dock-overlay` 浮层宿主，显示阻塞提示并禁止被阻塞会话继续提交 |
| `web/components/dialogs/RequestDock.js` | 将扩展请求分发给 package 专用界面或通用请求界面 |
| `web/components/composer/PromptQueuePanel.js` | 展示、添加和删除 Steering / Follow-up 队列项 |
| `web/stores/prompt-queue-actions.js` | 队列单条的改类型与删除提交（长条与面板共用，带 `revision`） |
| `web/stores/prompt-queue-actions.js` | 队列单条的改类型与删除提交（长条与面板共用，带 `revision`） |
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
  priority: number,          // 越大越靠前（折叠态在上、展开态在左）
  arrivedAt: number,         // 同优先级时越早越靠前
  plain?: boolean,           // true = 标题按纯文本渲染（队列长条用的是用户正文）
  strip?: boolean,           // true = 只在折叠态出现的长条（队列单条 / 「还有 N 条」）
  panelOnly?: boolean,       // true = 只在大框顶部那一行出现（队列面板本体）
  queueItem?: QueueItem,     // 长条对应的那一条队列消息
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
| 队列长条（引导） | 620 | 该条消息在 Steering 里 | 否 |
| 队列长条（排队） | 610 | 该条消息在 Follow-up 里 | 否 |
| 「还有 N 条」 | 590 | 队列总数 > `QUEUE_STRIP_LIMIT`（5） | 否 |
| 队列面板本体 | 500 | 队列非空（**只在大框顶部那一行**） | 否 |

Prompt 队列在**折叠态是一条消息一个长条**（用户 2026-09-29）：引导整组在前、排队在其后，同组内后到的在下面；只平铺最靠前的 5 条，剩下的收进一条「还有 N 条」。长条的标题就是那条消息的正文（纯文本，不当 inline Markdown 解析），行最左侧的图标按类型区分（引导 = `send`、排队 = `mode`），其后是**当前类型徽片**（`.activity-tab-kind`，写「引导」或「排队」，引导那一枚用强调色描边）与最多两张 18px 图片缩略图；行右侧依次是**目标类型**的「改为引导 / 改为排队」文字按钮与「删除」图标按钮（徽片写「排队」的那条，按钮就是「改为引导」，反之亦然）—— 两个按钮是 `role=tab` 按钮的**兄弟节点**，不能嵌进去。点长条（或「还有 N 条」）展开的是**同一份整体队列面板**：`panelOnly` 那个 tab 才是面板本体，所以 `expanded` 存的是它的 id，单条长条被消费不会把面板带走；面板开着时顶部只显「消息队列 N」。

总数为 0 时什么都不渲染，即使模型正在生成也不会显示“消息队列 0”。普通 Composer 提交的 Prompt 默认进入 Follow-up 排队。活动面板不提供重复标题或第二个输入区，只管理已有项：面板内始终保留上方「引导队列」和下方「排队队列」，空分组显示“暂无”，引导队列使用浅色背景；可把排队项转换为 Steering 以引导当前轮，也可转回排队，并支持编辑文字和图片或删除。图片以可点击预览的缩略图显示；编辑状态可选择、粘贴、拖入和移除图片，纯图片消息也可保存。**新增、编辑或跨队列转换不再自动展开面板**（用户 2026-09-29），只让新增或修改后的具体消息边框闪烁两次；分组外框不闪烁，纯删除和 Pi 正常消费队列不触发。

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

## 标题：inline Markdown

tab 标题（`tab.label`）允许 inline Markdown，渲染走 `renderInlineMarkdown()`（`web/markdown.js`）：

- 用 `marked.parseInline`，只出行内标记；永远不会产生 `<p>`/`<ul>`/`<pre>` 这类块级盒子（tab 是一行 26px 高的槽位，块级元素会把它顶变形）。
- 清洗比正文更严：`ALLOWED_TAGS` 只放行行内标签（不含 `a`/`img`/`script`/`p`），且 `ALLOWED_ATTR: []` 把属性全清 —— 链接降成纯文本，因为 tab 自身就是可点击元素，不能套嵌套交互。
- `marked` / `DOMPurify` 缺席时退化为转义后的原文：宁可看到反引号，也不能渲染成空白标题或原始 HTML。
- 徽片样式挂在共用的行内代码规则上（`:is(.body,.markdown,.turn-title,.activity-tab-label) :not(pre)>code`），tab 内只补 `padding:0 4px;font-size:.92em;line-height:1.25`；上下内边距必须收掉，否则行盒被撑高、整条 tab 跟着长高。
- 需要**纯文本**的位置（按钮 `title` 浮层、`blockedMessage()` 的提示行）必须先过 `stripInlineMarkdown()`，否则浮层里会漏出带反引号的源码。它在摘 `*`/`_` 时只认词边界，`ask_user_question` 这类包名不会被剔字。
- Prompt 队列 tab 的 label 是「消息队列 」加一对反引号包住的总数，页面上渲染成「消息队列 `3`」，与轮次标题「思考`3` · 工具调用`5`」共用同一套徽片语言；`textContent` 仍是「消息队列 3」。
- **队列长条的标题不走 inline Markdown**（tab 上 `plain: true`）：它直接是用户写的正文，`**`、反引号、`_` 都必须按字面显示，不能当样式解析，也不能去翻用户输入里的星号。

折叠态按方向键只移动焦点；已有面板展开时，方向键同时切换内容（折叠态纵向，上下键与左右键同义）。点击 tab 会展开或切换；**点击当前正在展示的那一个 tab 则折叠整栏**（再点自己 = 收起）。折叠入口共三个：点当前 tab、行尾最小化按钮、`Esc`。折叠的焦点归还发生在 160ms 退场动画结束时；如果刚展开的那个 tab 只在展开态出现（例如队列面板本体），折叠后行里没有它，`focusTab` 退回聚焦行内第一个可见 tab。

队列单条消息的改类型与删除走 `web/stores/prompt-queue-actions.js` 的 `usePromptQueueActions(token, onError)`（返回 `{ changing, mutate, remove }`）：它把 `queue_update_item` / `queue_remove` 的提交、`revision` 下发与报错上浮集中在一处，**折叠态长条右侧的两个按钮与面板里的同类操作共用这一份**。两个组件各自调一次 hook（各有自己的 `changing`），并发误改靠服务端 `revision` 拦住。

扩展请求首次出现时，活动栏会自动展开尚未自动展示过的第一个请求。用户手动折叠后，不再因普通扩展请求自动打断用户；所有活动消失后会清空这份临时选择状态。**Prompt 队列已不再自动展开**（用户 2026-09-29）：新增、编辑或跨队列转换只算出需要提醒的那几条，让它们在面板开着时闪两下，不再动面板的开合状态。

非当前面板不能卸载。它们保留在 `.activity-panel-host.is-collapsed` 中，以 `height:0; overflow:hidden` 隐藏。这样切换 tab 或折叠后，问卷草稿、选项状态和 xterm 实例不会丢失。共享 tab 行只渲染一份，禁止在每个隐藏面板中复制 tab 行。

## 键盘与 ARIA

tab 行使用 `role="tablist"`，每个按钮使用 `role="tab"`、`aria-selected` 和 `aria-controls`；展开面板使用 `role="tabpanel"` 与 `aria-labelledby`。

键盘规则：

- `ArrowLeft` / `ArrowRight`：循环移动（展开态横向）；
- `ArrowUp` / `ArrowDown`：同上（折叠态纵向堆叠，上下键才是顺手的）；
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
- 普通扩展请求的自动展开不会覆盖用户手动折叠；Prompt 队列的任何变化都不自动展开面板（只闪烁提醒）；
- 切换和折叠后表单草稿仍存在；
- 键盘循环、Home/End、Escape 和焦点恢复正确；
- 阻塞提示名称与 tab 名称一致，发送入口全部被禁用；
- 内部滚动到边界后不会带动主会话；
- 展开/折叠不改变消息区滚动位置和 dock 高度；
- 浅色、深色、窄屏和 reduced-motion 均可用；
- package 专用代码保持按需加载，未安装对应 package 时静默无副作用。
