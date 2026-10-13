# 文件引用与上传设计

状态：**TODO — 已定稿，用户 2026-09-25 明确决定暂不实现**。仓库里与本文相关的实现代码一行也没有；不要顺手开工，要开工请明说。

本文是实现这一功能的唯一依据，含被推翻的方案与推翻理由，避免下一轮重新推导。

## 1. 目标与非目标

**目标**

- 用户能把「一个文件 / 一个目录」交到当前会话里，让模型去读它。
- 终端所在机器上已有的文件：**不拷字节**，只交出路径（引用）。
- 人不在终端那台机器前（手机、另一台电脑）时：能把本地文件交到服务器上（上传）。

**非目标**

- 不做文件管理器 / 工作区浏览器（`@` 补全不等于文件面板）。
- 不做下载方向（页面读服务器文件）。
- 不改图片附件那条已经跑着的路径（继续 base64 + `image` 内容块）。

## 2. 三条决定天花板的硬事实

这三条把可行解空间压到只剩一种，所有后续口径都由此推出。

1. **Pi 的消息内容块里没有“文件”。** `@earendil-works/pi-ai` 的用户消息只接受 `text` / `thinking` / `image{data,mimeType}` / `toolCall`（`pi-ai/dist/types.d.ts` 的 `ImageContent` 等；该包 247 个 `.d.ts` 里搜不到 `"document"`）。→ **文件不能作为附件喂给模型**，唯一口径是「落到终端那台机器的磁盘上 + 消息里写路径」，由模型自己 `read`/`bash`。
2. **浏览器永远给不出绝对路径。** `<input type=file>` 的 `value` 恒为 `C:\fakepath\<名字>`；`File.path` 从未标准化且 **Electron 已在 32.0.0 移除**；`webkitRelativePath` 只给相对所选目录的路径；WICG `file-system-access` issue #145（要求暴露路径）自 2021 年开放至今。→ 「同机就只传路径」在浏览器侧不可实现。
3. **`/api/action` 不能承载文件。** 它是 JSON-only、`for await` 全量进内存再 `JSON.parse`、**没有体积上限**（图片现在走 base64，×1.33 膨胀且整包驻留，本身就是一个可被凭证持有者打爆内存的面）。→ 上传必须走新的 raw-body 端点，顺带给 action 通道补一个上限。

**由此推出的唯一正解**：引用走**服务器侧原生对话框**（pi 与终端同机，对话框弹在同一块屏幕上，stdout 回绝对路径）；上传走**新的流式端点**。中途曾设计的「服务端按 name + size + mtime 反查定位」在确认第 2 条与原生对话框可行之后**整个删除**——它只是为了补一个不必存在的缺口。

## 3. 最终形态

| | `@` 引用（输入语法） | 选择文件（入口） | 上传文件（入口） |
|---|---|---|---|
| 同机 | ✅ | ✅ 服务器原生对话框 → 得到路径，**底层就是引用** | 可用，但同机没必要 |
| 异机 | ✅ 指向**终端那台机器**的路径 | 同上（对话框弹在服务器上，客户端可能看不见 → 必须超时 + 提示） | ✅ 主要通路 |

页面展示统一成同一种附件卡，只有卡上一行小字区分「引用」与「已上传」——语义真的不同：**引用是实时的**（文件改了，模型下次读就是新的），**上传是快照**。不写这一行必定踩坑。

输入卡加号菜单最终六项（仍无分组小标题）：添加图片（不变）/ **选择文件** / **上传文件** / 斜杠命令 / 附加技能 / 压缩上下文。

## 4. 术语

| 术语 | 指什么 | 代码/选择器 |
|---|---|---|
| **引用** | 消息里的一个路径，文件不拷贝，模型自己读 | `@docs/spec.md` 字面 |
| **上传** | 字节拷进 `~/.pi/atom/uploads/<sessionId>/`，得到副本 | `.pi-attachment.is-uploaded` |
| **附件卡** | 从消息文本里的 `@` 记号解析出来的条目 | `AttachmentCard`（待定名） |
| **原生对话框** | 服务端 `spawn` 的操作系统选择框 | `pickNativePath()`（待定名） |

## 5. `@` 引用

- **语法**：输入框里打 `@` 触发补全（与 `/` 命令菜单互斥、共用同一个浮层位置与键盘导航）。补全插入裸路径；路径含空格时插入引号形式 `@"docs/my file.md"`。解析器同时接受裸写与引号形式。
- **消息文本就是事实**：消息 content 里保留 `@docs/spec.md` 字面（模型看到的与页面解析的是同一份文本，**不双份、不隐藏**）。页面从字面解析成附件卡。
  - 选它而不是记进 `web-state.json` 的 entryId 关联：后者在分支、编辑重发、导出会话时必然丢关联，卡片凭空消失。代价是编辑重发时删掉那段字面卡片就没了（降级为不显示，不报错）。
- **一律不内联内容**。只写路径。内联会让路径消失、模型无法重读、改一个字要重发整条。内联只属于上传的文本文件（§8.5）。
- **不检测失效**：文件后来被删/改名，页面不做任何探测，模型 `read` 自然报错（用户 2026-09-25 选定，避免为 hover 发请求）。
- **路径范围：完全不限制**（用户 2026-09-25 选定；两个环境都不限，见 §10 的安全声明）。服务端只校「存在 + 可读」，不校位置。
- **必须黑名单**（存在性检查本身会咬人）：`\\.\`、`\\?\`、`\Device\`、Win32 保留名（`CON`/`PRN`/`AUX`/`COM1`…/`NUL`）。这些 `stat` 得动但读会挂住或灌爆上下文。
- **引用目录**：只回第一层条目数，**绝不递归**。否则有人手输 `C:\Windows` 让模型去 ls。
- 与选择器的分工：选择器给目录 → 目录整体作为一个引用（同样是引用目录本身，不逐文件展开）。

## 6. 服务器原生对话框

同生态先例：`hyperpuncher/pi-ui` 的 `src/native-file-picker.ts`（Deno 写的，命令与退出码约定可直接搬到 Node `spawn`）。

| 平台 | 命令 |
|---|---|
| Windows | `powershell.exe -NoProfile -STA -Command` + `Add-Type -AssemblyName System.Windows.Forms`，`OpenFileDialog`（`Multiselect = $true`）或 `FolderBrowserDialog`，`ShowDialog() -eq OK` 后 `[Console]::Write(...)` |
| macOS | `osascript -e 'choose file with prompt … with multiple selections allowed'` / `choose folder`，配 `POSIX path of` |
| Linux | `zenity --file-selection [--multiple --separator=\n]` / `--directory`；回退 `kdialog --getopenfilename` / `--getexistingdirectory`；按 `XDG_CURRENT_DESKTOP` 排优先级 |

四个必办细节，漏一个就是新 bug：

1. **显式 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`**，否则中文路径乱码。
2. **取消 = 非零退出码**（WinForms 取消走 `DialogResult.Cancel`、脚本不输出 → 退出码 1 或空 stdout）。必须当成「用户取消」（静默、不报错、不弹通知），不能进 `report(error)`。
3. **焦点与崩溃**：Windows 上对话框可能弹在终端窗口后面（多个 SO 报告 + Windows Terminal issue）；PowerShell 7.5.5 有一条 `0xc0000409` 崩溃报告。**所以固定用 `powershell.exe`（5.1，`-STA` 默认成立），不要用 `pwsh`。** 本机实测：`PSVersion=5.1.22621.4391`、`-STA` 生效（`Apartment=STA`）、WinForms 可加载、`OpenFileDialog` 可实例化。
4. **绝不阻塞**：动作是异步的、带超时（90s）；页面上立刻提示「已在本机（终端所在机器）弹出选择框」。异机点了看不见窗口是这个入口的固有代价，靠超时 + 提示兜住，不加额外判断。

## 7. `@` 补全的数据源

- 需要服务端**逐级枚举目录**（用户 2026-09-25 选定「补全也任意路径」）：新端点按「目录 + 前缀」返回条目（名字、是否目录、size、mtime），排序偏好：目录优先 → 前缀命中 → 短路径优先。
- 同机在项目内时另走一条**模糊搜索**（扫 `cwd` 子树，尊重 `.gitignore`、跳 `.git`/`node_modules`、索引缓存、文件数上限），因为“打 `src/comp/At` 找到 `web/components/AttachMenu.js`”比逐级点有用得多。
- 上限：单次返回条数（200）、单次扫描文件数（20k）、索引缓存按目录 mtime 失效。
- 风险声明见 §10：这是本设计里信息量最大的一个面。

## 8. 上传通路

### 8.1 端点与形态

- `POST /api/upload`，**raw body**，元数据走头：`x-atom-name`、`x-atom-type`、`x-atom-relpath`（目录内相对路径）、`x-atom-upload`（目录上传的批次 id）。服务端 `req.pipe(fs.createWriteStream(...))`，内存不驻留整包。
- 不用 `multipart/form-data`：要自己写解析器，换来的只有“一次发多个文件”，而那用 N 个请求更好做进度与重试。
- 一文件一请求，前端并发 3–4，进度按字节汇总。
- **开工第一件事：实测 `gateway.mjs` 转发 body 是流式 pipe 还是缓冲。** 若是缓冲，局域网上传会把 32MB 整包堆在网关内存里 → 先把 upload 路径改成流式，否则上限形同虚设。

### 8.2 三层上限

1. `content-length` 预检 → 超限直接 413，不开始写。
2. 流上计数器 → 超 32MB 立即断开并删除半截文件。
3. 累计配额 **512MB** → 满则按 mtime 升序删最老（LRU），无感、不提醒。

### 8.3 LRU 与 pinned

- 不按时间清理（用户 2026-09-25 选定「不 N 天自动清，达到 512MB 再删」）。
- **LRU 跳过已被消息引用的文件**（用户选定）：`web-state.json` 里记 `referencedUploads: string[]`（写入消息时登记）。否则配额打满那一刻会随机烂掉历史消息里的路径，而且最容易烂在“刚引用完”的位置。
- 全是 pinned 且仍超配额 → 报一次「上传目录已满，请先清理」。这是全流程唯一一次提醒。

### 8.4 文件名与目录

- 服务端 `basename()` + 控制字符/Win32 保留名清洗 + 逐段拒 `..`、绝对路径、盘符；最终 `path.resolve` 后断言仍在 uploads 内。`webkitRelativePath` 是浏览器给的，**不可信**，同样逐段清洗。
- 同名冲突：单文件 `name-2`；目录上传是**整个目录一个后缀**（`mydir-2/`），不能逐文件算，否则一次上传散成一堆编号。
- **目录原子提交**：`webkitdirectory` 批次先写 `.upload-<id>/`，全部成功才 rename 成正式名；中途失败整个临时目录丢弃。绝不给模型半个目录。
- 默认**跳过 `.git/` 与 `node_modules/`**，附件卡上给一行「已跳过 `.git`（3.2 GB），点这里包含它」，用户可手动打开（不静默删用户数据）。
- 去重：同名 + 同 size + 同 mtime 命中已有副本 → 复用，不重传（顺带避免「LRU 删了又重传、再删」的来回搬运）。

### 8.5 文本文件内联（只属于上传）

- 判据：扩展名白名单 **且** 前 8KB 无 NUL 字节 —— 否则一律当二进制落盘（防把 `.bin` 当文本灌进上下文）。
- **≤64KB 直接把内容贴进消息**（省一次 `read` 往返）；>64KB 落盘给路径。

### 8.6 消息文案

模型唯一的知情途径就是这段文本，写清楚优先于好看：

```
附件文件：docs/spec.md（18.2 KB，已保存到 ~/.pi/atom/uploads/<sessionId>/docs/spec.md）
```

`@` 引用一侧则是 `@路径` 字面。两种都由页面解析成附件卡。

### 8.7 提交顺序与 UI

- 先传、**全成功才发消息**；任一失败保留附件、禁用发送、给重试。
- 附件条显示进度（目录按字节汇总）、跳过的垃圾目录、同名冲突后的最终名字。
- 附件卡必须能一眼分辨「引用（未拷贝）」/「已上传」。

## 9. 同机 / 异机判定

- 判定：`req.socket.remoteAddress` 是回环 **且** 未经网关转发（无 `connection.proxy` / `x-forwarded-prefix`）。**逐请求判**，不是启动时判——`/web-wlan` 下本机也可能用 LAN IP 访问。
- 判错方向的后果可接受：同机但被判成异机 → 退化成上传（安全方向）。
- **SSH 端口转发会误判成同机**（`remoteAddress` 是 127.0.0.1；`opencode` PR #31848 踩过同一条）。但在新架构下语义仍然正确：对话框弹在 pi 所在机器 = 就是「引用终端所在机器」的语义，符合选定口径；远程客户端看不见窗口由 §6 第 4 条（超时 + 提示）兜住。**因此不引入新判据、不加“假定异机”开关。**

## 10. 安全边界（明确写下，别等出事再补）

用户 2026-09-25 明确选定：**`@` 引用与 `@` 补全在两个环境都完全不限制路径**。因此：

- 任何拿到局域网地址 + 凭证的人，获得**服务器任意文件读取入口**（`@` 路径交给模型读）与**服务器目录树枚举能力**（补全端点，列 `C:\Users` 即可拿到用户名列表）。
- 与既有待办叠加：局域网网关（31360）不校 Host/Origin、网关本身不鉴权、固定凭证让泄露地址长期有效、注册密钥在 Windows 上只是 `0600` 请求。**风险是叠加的，不是并列的。**
- 缓解（本轮只做到这些）：上传侧的目录/配额限制保留；引用与补全**不加开关**（用户不要），但本文件与 README 必须把上面的话原文告知；将来若要收紧，最小改动是给补全端点加目录白名单、把 `@` 引用限到 cwd + uploads。
- 同机侧不视为主防线：同机场景下持有凭证者本来就能在消息里让模型 `cat` 任意文件，路径白名单在同机只是防手滑与防 UI 泄露。

## 11. 需要新增/改动的面

| 面 | 内容 |
|---|---|
| 新端点 | `POST /api/upload`（raw body 流式）、`POST /api/list-dir`（补全用，逐级枚举）、`GET/POST /api/search-files`（cwd 子树模糊搜索） |
| 新 action | `pick_path`（服务端原生对话框；返回路径或取消） |
| 协议 | `shared/protocol.ts` + `.js` **两份同改**：新 action 类型、新快照字段 `fileAttach: {uploadsDir, usedBytes, quotaBytes, maxBytes, sameHost, nativePicker: {platform, available}}`。少一份会让整个快照/patch 被 `validateField` 静默丢弃 |
| 前端 | `AttachMenu.js` 两项、`@` 补全（复用 `#command-menu` 位置与键盘导航，与 `/` 互斥）、`AttachmentCard`、上传队列与进度、`apiPath()` 走前缀 |
| 状态 | `web-state.json` 增 `referencedUploads` |
| 顺带 | 给 `/api/action` 加 JSON 体积上限（现在无上限） |
| 文档 | `DETAILS.md`（新章：文件引用与上传）、`README.md`（能力 + §10 风险告知）、`CHANGELOG.md`、`AGENTS.md` 索引 |

## 12. 实现顺序

1. **先实测网关是否流式转发 body**（§8.1）——它决定上传上限是否可信。
2. `@` 引用闭环：解析 + 附件卡 + `pick_path` 原生对话框 + 消息字面。（同机可用、异机可用，无拷贝，最小可见闭环。）
3. 补全：`list-dir` + `search-files` + 输入框 `@` 触发与键盘导航。
4. 上传闭环：端点 + 三层上限 + LRU/pinned + 去重 + 附件条进度 + 失败阻止发送。
5. 目录上传：`webkitdirectory` + 原子提交 + 垃圾目录跳过/包含。
6. 文档五处同步 + `npm run check`。

## 13. 测试口径（按项目约定：测试文件一律不写、不改、不跑）

实现时预期会红/需改的既有用例（**只点名，不动手**）：

- `test/browser/web.spec.js` 里断言加号菜单**条目数量或文本清单**的用例：菜单从四项变六项。
- 任何 `#command-menu` 的键盘导航用例：新增 `@` 触发后，`matches` 的数据源变成两种之一，须钉住「输入 `/` 走命令、输入 `@` 走文件」。
- 附件相关 fixture：若给 `image` 之外新增附件类型，`web.setSnapshot` 的 fixture 形状不变（消息文本自包含），预期**不需要**改。

## 14. 已知未决与风险

- 网关 body 是否流式（§8.1，实现第一步实测）。
- Windows 对话框焦点/崩溃（§6 第 3 条）：固定 `powershell.exe` 5.1，但「弹在终端后面」若复现，需要加一个 topmost 的隐藏 owner 窗口。
- 引用路径会写进会话记录 → 导出/分享会话即带出本机目录结构（含用户名）。局域网分享地址时同等暴露。
- `@` 补全的枚举端点是本设计最大的信息面（§10）。
- 大目录引用（如 `C:\Windows`）会让模型 `ls` 一下烧掉大量上下文；§5 的「只报第一层」只是缓解，不做二次确认。

## 15. 参考来源

- MDN：`input type=file`、`File.webkitRelativePath`、Using files from web applications
- WHATWG File System API / WICG `file-system-access`（issue #145：要求暴露绝对路径，未实现）
- Electron 32.0.0 移除 `File.path`；electron/electron#33647
- 服务端原生选择框先例：`hyperpuncher/pi-ui` `src/native-file-picker.ts`、`receptron/mulmoterminal` `server/files/pick-file.ts`、`thinkany-ai/termany` `folderPicker.ts`、`frrabelo/kanban_Cline` `directory-picker.ts`
- SSH 端口转发让 `localhost` 误判为本机：`anomalyco/opencode` PR #31848
- PowerShell WinForms 对话框：STA 要求（powershell#27457）、焦点问题（SO 3936283 / 25370342 / 54037292、Windows Terminal#6633）、7.5.5 `0xc0000409`
