# INSTALL — 给 Agent 的安装手册

本文面向**执行安装的 agent**（pi 自身、Codex、Claude Code、Cursor 等），按顺序照做即可，不需要读源码。
人类读者也可以读；使用与功能说明在 [`README.md`](README.md)，开发约定在 [`AGENTS.md`](AGENTS.md) + [`DETAILS.md`](DETAILS.md)。

关键前提：**这是一个 pi 扩展，不是独立服务，也没有前端构建步骤。** 它由 pi 进程加载，把当前 TUI 会话暴露成一个本地 HTTP 页面。

---

## 0. 先决条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| pi | 已安装并能进 TUI；需支持 `ExtensionContext.mode`、消息事件与 `sendUserMessage`（与 `package.json` 里 `@earendil-works/pi-coding-agent` 的 `^0.85.1` 同档） | `pi --version` |
| Node.js | **22.18 或更高**（扩展后端是 `.ts` 入口，靠 Node 原生类型剥离直接加载，无编译产物） | `node --version` |
| npm | 能跑 `npm ci`（会读 `package-lock.json`） | `npm --version` |

Windows 上 `npm` 常常不在 PATH。此时不要判定“装不了”，改用绝对路径调用，例如
`& "C:\Program Files\nodejs\npm.cmd" ci`；仓库自带的验证脚本可以绕过 npm 直接跑（见 §4）。

---

## 1. 放到扩展目录

pi 扫描 `~/.pi/agent/extensions/` 加载扩展，本仓库必须落在名为 `pi-atom-web` 的子目录里（目录名影响扩展的显示名，不建议改名）：

- Linux / macOS：`~/.pi/agent/extensions/pi-atom-web/`
- Windows：`%USERPROFILE%\.pi\agent\extensions\pi-atom-web\`

```bash
git clone https://github.com/WJBFks/pi-atom-web.git ~/.pi/agent/extensions/pi-atom-web
cd ~/.pi/agent/extensions/pi-atom-web
```

已经存在该目录（例如从别处拷来的）时：先 `git -C . status` 看有没有本地改动，**不要直接覆盖或删除用户的目录**，有冲突先问用户。

入口由 `package.json` 声明，不需要额外注册：

```json
"pi": { "extensions": ["./extensions/index.ts"] }
```

---

## 2. 安装依赖（必须，且是运行期依赖）

```bash
npm ci
```

**这一步不能省。** 页面上的第三方库不是打包进仓库的，也不是 CDN，而是由扩展在运行期**直接从 `node_modules/` 读文件**提供（映射见 `extensions/server.ts`）。少装任何一个依赖的表现都是页面白屏或功能静默缺失：

| URL | 实际来源 | 用途 |
|---|---|---|
| `/vendor/vue.js` | `node_modules/vue/dist/vue.runtime.esm-browser.prod.js` | 框架（importmap 的 `vue`） |
| `/vendor/pinia.js` | `node_modules/pinia/dist/pinia.esm-browser.js` | 状态管理 |
| `/vendor/vue-router.js` | `node_modules/vue-router/dist/vue-router.esm-browser.prod.js` | 路由（memory history） |
| `/vendor/devtools-api/*` | `node_modules/@vue/devtools-api/lib/esm/*` | vue 的间接依赖 |
| `/marked.js` | `node_modules/marked/lib/marked.umd.js` | Markdown 渲染 |
| `/purify.js` | `node_modules/dompurify/dist/purify.min.js` | Markdown/HTML 清洗（安全必需） |
| `/highlight.js` | `node_modules/@highlightjs/cdn-assets/highlight.min.js` | 代码高亮 |
| `/xterm.js`、`/xterm.css` | `node_modules/@xterm/xterm/{lib,css}/...` | 自定义终端视图 |
| `/fonts/*.woff2` | `node_modules/@fontsource-variable/noto-sans-mono/files/...` | 本地字体（不走外部 CDN） |

要点：

- **`web/vendor/` 目录在仓库里并不存在**，它是服务端挂载路径。别去找它、也别自己创建或往里拷文件。
- 依赖版本已在 `package-lock.json` 锁死，因此用 `npm ci` 而不是 `npm install`（后者可能改动 lock）。只有在故意升级依赖时才 `npm install` 并提交 lock 变更。
- 只想跑界面、不跑测试时可以 `npm ci --omit=dev`；但那样 §4 的 `check` / `test` 跑不了。
- devDependencies（`@playwright/test`、`@earendil-works/pi-coding-agent`）**只在开发时需要**，运行扩展不需要。要跑浏览器测试再补一句浏览器本体：`npx playwright install chromium`（Windows 默认走已装的 msedge channel，通常不用下载，见 `playwright.config.js`）。

**绝对不要**在本仓库引入构建步骤：不要 `vite` / `webpack` / `tsc` 出 `dist/`，不要为“缺 vendor 文件”而生成文件，不要把依赖改成 CDN 链接。CSP 的 `script-src` 里带 importmap 的 sha256（启动时从磁盘原文计算），动 `web/index.html` 的 importmap 字节会直接白屏。

---

## 3. 加载并打开

1. 让 pi 重新加载扩展：在**已运行的 pi** TUI 里执行 `/reload`；全新安装的直接启动 `pi` 即可。
2. 在同一个会话里执行：

```text
/web
```

TUI 会打印完整地址（形如 `http://127.0.0.1:31359/<会话短码>/#<凭证>`）并尝试自动开浏览器。再次执行 `/web` 复用已有服务。

其他命令：

| 命令 | 作用 |
|---|---|
| `/web-wlan` | 监听 `0.0.0.0`，局域网可访问（凭证只剩 URL 里那串，风险自担） |
| `/web stop` | 只停本会话的服务与它的路由登记 |
| `/web auto on \| off \| status` | 重启 pi 后是否自动恢复 Web 服务的总开关 |

网关（多会话共用固定端口的那层）由第一个 `/web` 用当前 Node 可执行文件 **detached 自动拉起**，不需要单独安装、不需要单独启动、不需要 systemd/计划任务。所有会话退出后它自行退出。

---

## 4. 验证装对了

按代价从低到高，**通常只需要第一条**：

```bash
npm run check          # 秒级：JS/TS 语法 + CSS 行首 // 的门
npm test               # Node 原生 test runner 跑 test/*.test.js
npm run test:browser   # Playwright 浏览器用例（较慢；本机 npm 不在 PATH 时见下）
```

npm 不在 PATH 或想跳过 npm 包装时，直接：

```bash
node scripts/check.mjs
node scripts/test.mjs
node node_modules/@playwright/test/cli.js test
```

安装场景下判定成功的标准是：`check` 通过 + 打开 pi 后 `/web` 能出地址 + 页面能加载出对话界面（浏览器 console 无 `Failed to resolve module specifier "vue"`）。

如果这个仓库是你**要修改的代码**而不是纯安装：遵守 [`AGENTS.md`](AGENTS.md) 的测试策略——测试文件一律不写、不改、不跑，改完只跑 `check`，其余交给用户 `/reload` 目检。

---

## 5. 运行期会写哪些文件（卸载时按此清理）

| 路径 | 内容 | 说明 |
|---|---|---|
| `~/.pi/atom/web/config.json` | 网关端口、`autoServe` 总开关、固定凭证开关 | 用户级、所有 pi 进程共用 |
| `~/.pi/atom/web/sessions.json` | 显式开过 Web 的会话登记表（`0600`） | `/web stop` 会抹掉条目 |
| `~/.pi/atom/web/gateway-<端口>.key` | 网关控制接口的启动密钥（`0600`） | 网关进程存活期间使用 |
| `<项目>/.pi/atom/<sessionId>/web-state.json` | 该会话的派生状态与统计（轮数、Token、成本等） | 随会话走 |

端口默认 `31359`（本机/局域网共用网关）与 `31360`（`/web-wlan`），可用环境变量 `PI_ATOM_WEB_PORT`、`PI_ATOM_WEB_LAN_PORT` 覆盖；固定端口被占用时只提示、不会自动改选。

**完全卸载**：在会话里 `/web stop`，删掉 `~/.pi/agent/extensions/pi-atom-web/`；上表的 `~/.pi/atom/web/` 与项目里的 `.pi/atom/` 属残留数据，用户要清盘时再删。

---

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 页面白屏，console 报 `Failed to resolve module specifier "vue"`（或 marked/purify 404） | 没跑 `npm ci`，或跑在了别的目录。在**扩展目录**执行 `npm ci` 后刷新页面。 |
| 改了代码但行为没变 | 后端逻辑在 pi 内存里，**刷新页面不会更新扩展**：必须 `/reload`（或重启 pi）再 `/web`。 |
| `/reload` 后仍跑旧代码 | 确认改动在 `.ts` 文件里。已复现加载器会缓存原生 ESM `.js`，**扩展后端一律用 `.ts`**，不要改回 `.js`。 |
| 协议字段改了但前端收不到、也没有报错 | `shared/protocol.ts` 与 `shared/protocol.js` 是**两份**，必须同时改；少一份会让整个 patch 被客户端静默丢弃。 |
| 打开收藏的地址出现一整排 404（`style.css`/`main.js`… 全红） | 会话短码前缀失效（pi 重启、会话退出）。正常应看到「会话不在线」等待页并每 3 秒重试；若没有，检查网关进程与 `~/.pi/atom/web/` 下的文件，或让用户重新执行一次 `/web` 拿新地址。 |
| 旧地址能开但提示凭证错误（401） | 默认凭证每次随机。要长期收藏地址，去「设置 → 会话 → Web 服务 → 固定凭证」打开。 |
| 固定端口被占用 / 想换端口 | 设 `PI_ATOM_WEB_PORT` / `PI_ATOM_WEB_LAN_PORT`，或删掉 `config.json` 里的端口字段。 |
| 第三方 package（如 `ask_user_question`）的卡片不显示 | 适配在 `extensions/packages/<pkg>/` 与 `web/packages/<pkg>/`，未安装该 package 时条目永不命中、不报错；不是安装失败。 |

---

## 7. 安装完成后请报告

- 扩展目录的绝对路径、`node --version`、`npm ci` 是否成功（装了多少包）。
- `npm run check` 的结果。
- `/web` 打出的地址（**如果开了固定凭证，不要把 URL 片段里的凭证贴到公开渠道**；本地终端里回显是可以的）。
- 任何上面表格没覆盖的报错原文。
