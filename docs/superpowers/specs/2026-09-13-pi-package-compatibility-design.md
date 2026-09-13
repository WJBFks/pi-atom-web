# Pi 第三方 Package 按需兼容架构设计

## 目标

为 Pi 第三方 package 建立后端与 Web 分层、按 package 名称组织、按需激活的兼容机制，并将 `@juicesharp/rpiv-ask-user-question` 2.9.0 的专用兼容完整迁入该机制。

## 目录与边界

```text
extensions/packages/
├── registry.ts
└── @juicesharp/rpiv-ask-user-question/
    ├── index.ts
    ├── adapter.ts
    └── result.ts

web/packages/
├── registry.js
└── @juicesharp/rpiv-ask-user-question/
    ├── index.js
    ├── AskUserForm.js
    ├── answers.js
    └── style.css
```

`extensions/packages/registry.ts` 只保存兼容描述符、候选工具调用和延迟加载状态。业务模块只在具有唯一性的公开事件 `rpiv:ask-user:prompt` 实际出现后动态导入，因此未安装或未使用 package 时不会执行专用代码、报错或通知。

`web/packages/registry.js` 将后端请求上的 `packageId` 映射到动态 `import()`。只有请求实际进入 Web store 后才加载对应组件及其本地样式。未知 package 不执行任何专用模块，继续由通用 custom terminal 兜底。

通用 `dialogs.ts` 只依赖统一的 package 请求接口：兼容模块可以认领 custom factory、产生结构化请求，并把 Web 答案转换为原 factory 的 done 结果。它不知道问卷字段和结果格式。

## 激活和数据流

1. 通用 registry 观察工具开始事件，仅保存兼容描述符需要的有界参数。
2. package 发出其公开 prompt 事件后，registry 确认它实际存在并首次动态导入后端兼容模块。
3. 模块关联工具参数与公开事件；事件只带 `hasPreview`，完整 preview 从同一工具调用参数取得。
4. 随后的 `ui.custom()` factory 由适配器认领，并产生带 `packageId`、`kind`、`questions` 和 `toolCallId` 的请求。
5. Web registry 看到 package 请求后动态导入专用 Vue 组件。
6. 首先在 Web 或 TUI 完成的一端调用原 done；另一端随 AbortSignal 或请求消失结束。
7. 工具结束、会话切换、reload 和扩展关闭时清理候选调用、请求及监听状态。

未安装 package 时只有通用 registry 的轻量描述符存在；不会导入专用模块，不会创建浏览器资源，也不会产生任何用户可见信息。

## rpiv-ask-user-question 2.9.0 功能覆盖

Web 表单支持：

- 1–4 个问题，原始 header、题号、单选/多选类型和 2–4 个选项。
- 单选、复选、自定义多行回答，以及多选与自定义回答并存。
- 每个选项的说明和单选 Markdown preview。
- 每题备注；备注不改变题目是否已回答。
- 多题 tab、上一题/下一题、核对页、未回答提示和部分提交。
- 核对页的全局备注，包括仅填写全局备注时仍可提交。
- 单题直接提交；多题通过核对页提交。
- 取消、收起/展开、草稿恢复、清除当前答案。
- 结果中的 `questionIndex`、`question`、`kind`、`answer`、`selected`、`notes`、`preview`、`globalNote` 和 `cancelled`。
- TUI 与 Web 首次完成者生效，未提交的两端草稿互不覆盖。

外部编辑器和终端快捷键是 TUI 输入方式；Web 原生多行 textarea、按钮和折叠控件提供等价能力，不模拟终端按键。

## 安全与兼容

- 浏览器仍使用 Vue 3 Composition API、render function 和原生 ESM，不增加构建步骤。
- Markdown preview 继续复用清洗后的 `MarkdownContent`。
- packageId、问题、选项、preview、答案和备注全部经过共享协议长度及结构校验。
- 不导入第三方 package 的内部源码，不依赖私有类；factory 只用版本特征守卫防止误认其他 custom 请求。
- 动态模块和 CSS 只能从 server 静态白名单提供，不连接 CDN。
- 不支持的或未知 package 请求安全回退到通用界面。

## 测试与文档

测试覆盖未激活时不加载、公开事件触发激活、调用关联和歧义拒绝、完整结果构造、全局备注、取消、Web 动态组件、全部题型、preview、草稿、部分提交与清理。最终运行 `npm run check`、`npm test` 和 `npm run test:browser`。

同步更新 README、CHANGELOG、AGENTS.md，并删除旧顶层专用文件与引用。

