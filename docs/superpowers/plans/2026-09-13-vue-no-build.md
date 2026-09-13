# Vue 无构建迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 落实已有设计，将当前会话 UI 迁移为本地 ESM Vue、Pinia 和 Router，保留交互并建立自动验收。

**Architecture:** Node HTTP 继续承载现有鉴权和接口；共享协议规范快照与增量。浏览器 transport 负责连接生命周期，stores 保持实体身份，Vue 组件拥有 DOM。

**Tech Stack:** Node 原生 TypeScript、Vue runtime ESM、Pinia、Vue Router memory history、Node test、Playwright。

**Spec:** ../specs/2026-09-13-vue-no-build-architecture-design.md

## Global Constraints

- 禁止构建工具、SFC、JSX、外部 CDN、运行时模板编译、unsafe-eval。
- 一对一宿主会话；保留 loopback、Host/Origin、Bearer、sessionId、256 KiB 请求限制。
- 保留现有全部 UI 行为；流式更新不重建历史或输入区域。
- 不调用真实模型或写真实会话；中文文档同步更新。

### Task 1: 共享协议与后端增量

文件：shared/protocol.js、extensions/server.ts、extensions/index.ts、test/protocol.test.js、test/server.test.js。

- [x] 写协议校验、鉴权、快照后增量、重连快照及会话切换测试，先验证缺失行为失败。
- [x] 导出 validateAction(value)、validateSnapshot(value)、validateServerEvent(value)；校验失败抛 Error，成功返回原值。事件为 {schemaVersion:1,type:'snapshot',streamId,sequence,sessionId,snapshot} 或 {schemaVersion:1,type:'patch',streamId,sequence,sessionId,patch}。patch 按字段携带变化值，messages 仅历史变化时发送。
- [x] 后端快照消息使用会话命名空间稳定 ID；保留合并窗口、15 秒心跳、write false 背压语义。
- [x] 运行 node --test test/protocol.test.js test/server.test.js。

### Task 2: Vue 页面与状态迁移

文件：web/main.js、web/app.js、web/router.js、web/index.html、web/api/*、web/stores/*、web/components/*、web/views/*、test/frontend.test.js。

- [x] 为凭证迁移、SSE 分帧与取消、状态引用稳定、Thinking 手动展开先写测试并确认失败。
- [x] 实现本地 runtime ESM 的 h()/setup() 组件，memory router，四个 Pinia stores。消费 Task 1 事件，通过单实例 fetch transport 校验、顺序检查和退避重连。
- [x] 逐区域迁移现有行为，删除该区域旧 DOM 写入；保留清洗 Markdown、Ask User、xterm、选择器、状态栏、命令、reload 标记与滚动规则。
- [x] 运行 Node 测试与真实浏览器验证；稳定历史节点和 Composer 焦点。

### Task 3: 本地依赖与验证工具

文件：package.json、package-lock.json、scripts/check.mjs、test/browser/*、playwright.config.js、README.md、CHANGELOG.md、AGENTS.md。

- [x] 核对并固定可原生导入的 npm 包；server 白名单提供所有 import-map 目标，CSP 仅加入固定 map hash。
- [x] check 递归检查 extensions、shared、web；test 无测试时失败。
- [x] 添加独立 test:browser，用伪造会话启动真实 HTTP 服务；覆盖本地模块/CSP、流式历史身份、焦点、路由与凭证、reload 和清理。
- [x] 运行 npm run check、npm test、npm run test:browser，独立审查后修复真实问题。
- [x] 同步中文文档、版本与完成记录。

## 执行记录

- 基线：0.2.49；check 通过；npm test 发现 0 个测试，不能作为回归基线。
- 接口裁定：初期允许字段 patch，后续消息实体增量由协议层统一适配；不允许每次流式发送历史数组。

## 完成验证

- 版本：0.3.0；分支：codex/vue-no-build。
- npm run check：36 个源文件通过。
- npm test：32 项通过。
- npm run test:browser：系统 Edge 下 17 项通过，包括 200 条历史与 40 次流式增量、桌面/窄屏、问卷与终端、工具合并和重载。
- 独立审查修复了宿主 message_end 早于历史追加的时序问题；历史与统计在发布窗口读取，纯 live 更新不访问历史。
- 已删除旧单体 app.js 与 ask-user.js，文档同步。验证使用内存 fixture，未调用真实模型或写真实会话。
