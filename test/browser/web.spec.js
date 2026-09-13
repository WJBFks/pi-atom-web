import { test as base, expect } from "@playwright/test";
import { startServer } from "../../extensions/server.ts";

const token = "a".repeat(64);
const fixture = (overrides = {}) => ({
  schemaVersion: 1,
  sessionId: "session-browser",
  instanceId: "instance-browser-a",
  name: "浏览器回归会话",
  cwd: "C:/workspace",
  model: "alpha/model-a",
  selectedModel: { provider: "alpha", id: "model-a" },
  modelOptions: [
    {
      provider: "alpha",
      providerName: "Alpha",
      id: "model-a",
      name: "Model A",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium"],
    },
    {
      provider: "beta",
      providerName: "Beta",
      id: "model-b",
      name: "Model B",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium"],
    },
  ],
  thinking: "medium",
  thinkingLevels: ["off", "low", "medium"],
  commands: [],
  busy: false,
  stats: {
    workspace: { name: "workspace", path: "C:/workspace" },
    startedAt: Date.now(),
    activeAt: Date.now(),
    usage: {},
  },
  messages: [{ id: "history-1", role: "assistant", content: "历史消息" }],
  liveMessage: null,
  tools: [],
  toolTimings: {},
  requests: [],
  ...overrides,
});

const test = base.extend({
  web: async ({}, use) => {
    let current = fixture();
    const actions = [];
    let actionHandler;
    let server = await startServer({
      snapshot: () => current,
      action: async (action) => {
        actions.push(action);
        if (actionHandler) return actionHandler(action, server);
        return action.type === "reload" ? { reloading: true } : {};
      },
      connection: { token },
    });
    await use({
      get server() {
        return server;
      },
      actions,
      setActionHandler(handler) {
        actionHandler = handler;
      },
      setSnapshot(next) {
        current = { ...current, ...next };
      },
      publish(patch) {
        current = { ...current, ...patch };
        server.publish(patch);
      },
      async restart(next) {
        current = { ...current, ...next };
        const connection = server.connection;
        await server.close();
        server = await startServer({
          snapshot: () => current,
          action: async (action) => {
            actions.push(action);
            return {};
          },
          connection,
        });
      },
    });
    await server.close();
  },
});

async function open(page, web) {
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(new URL(`/#${token}`, web.server.url).toString());
  await expect(
    page.locator("#message-history"),
    `页面错误：${failures.join("; ")}`,
  ).toContainText("历史消息");
  return failures;
}

test("loads local ESM modules under CSP without page errors", async ({
  page,
  web,
}) => {
  const failures = await open(page, web);
  expect(failures).toEqual([]);
});

test("renders arbitrary appendEntry data as a generic custom entry card", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      { id: "history-1", role: "assistant", content: "历史消息" },
      {
        id: "custom-1",
        role: "customEntry",
        customType: "third-party:status",
        data: { active: true, count: 2 },
        collapsedText: "[third-party] 状态正常",
        expandedText: "[third-party] 状态正常\n任务数量：2",
        timestamp: "2026-09-13T10:00:00.000Z",
      },
      {
        id: "notification-1",
        role: "notification",
        level: "info",
        content: "调度器  启动\n完成",
      },
      {
        id: "custom-2",
        role: "customEntry",
        customType: "json-only",
        data: { phase: "idle" },
      },
    ],
  });
  await open(page, web);
  const card = page.locator('[data-custom-entry="third-party:status"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/disclosure-block/);
  const summary = card.locator(":scope > summary");
  await expect(summary).toContainText("third-party:status");
  await expect(summary).toContainText("[third-party] 状态正常");
  await expect(summary).toHaveCSS("white-space", "nowrap");
  await summary.click();
  await expect(card).toContainText("任务数量：2");
  await card.locator(".custom-entry-raw summary").click();
  await expect(card).toContainText('"active": true');
  await expect(card).toContainText('"count": 2');
  const notice = page.locator('[data-notification="info"]');
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveClass(/disclosure-block/);
  await expect(notice).not.toHaveAttribute("open", "");
  await expect(notice.locator(":scope > summary")).toContainText("调度器 启动 完成");
  await notice.locator("summary").click();
  await expect(notice).toContainText("调度器  启动\n完成");
  const jsonOnly = page.locator('[data-custom-entry="json-only"]');
  await expect(jsonOnly.locator(":scope > summary")).toContainText("[JSON OBJECT]");
  await jsonOnly.locator(":scope > summary").click();
  await expect(jsonOnly.locator(".code-block")).toContainText('"phase": "idle"');
});

test("conversation fills the viewport without the product header or session sidebar", async ({
  page,
  web,
}) => {
  await open(page, web);
  await expect(page.locator("#app-shell > header")).toHaveCount(0);
  await expect(page.locator(".layout > aside")).toHaveCount(0);
  await expect(page.locator(".layout")).toHaveCSS("height", `${await page.evaluate(() => innerHeight)}px`);
});

test("long history keeps its nodes and does not steal scroll position during streaming", async ({
  page,
  web,
}, info) => {
  web.setSnapshot({
    messages: [
      fixture().messages[0],
      ...Array.from({ length: 200 }, (_, i) => ({
        id: `long-${i}`,
        role: "assistant",
        content: `历史记录 ${i}\n\n这是用于滚动验证的固定内容。`,
      })),
    ],
  });
  await open(page, web);
  await page.locator("#scroll").evaluate((node) => {
    node.style.scrollBehavior = "auto";
    node.scrollTo({ top: 0, behavior: "instant" });
    node.dispatchEvent(new Event("scroll"));
    window.__oldMessage = document.querySelector("#message-history .message");
  });
  const started = performance.now();
  for (let i = 0; i < 40; i++)
    web.publish({
      liveMessage: {
        id: "long-live",
        role: "assistant",
        content: `流式片段 ${i}`,
      },
    });
  await expect(page.locator("#message-live")).toContainText("流式片段 39");
  expect(await page.locator("#scroll").evaluate((node) => node.scrollTop)).toBe(
    0,
  );
  expect(
    await page.evaluate(
      () =>
        window.__oldMessage ===
        document.querySelector("#message-history .message"),
    ),
  ).toBe(true);
  info.annotations.push({
    type: "performance",
    description: `200 条历史 + 40 次增量，最终可见更新 ${Math.round(performance.now() - started)}ms`,
  });
});

test("questionnaire preserves multi selections with custom text and submits plain answers", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-one",
        kind: "ask_user_question",
        questions: [
          {
            header: "选择功能",
            question: "需要哪些功能？",
            multiSelect: true,
            options: [
              { label: "A", description: "甲" },
              { label: "B", description: "乙" },
            ],
          },
        ],
      },
    ],
  });
  const errors = await open(page, web);
  await expect(page.locator(".ask-title")).toHaveText("选择功能");
  await page.locator('[data-ask-option="0"]').check();
  await page.locator("[data-ask-text]").fill("其他");
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft[0]).toMatchObject({
    kind: "multi",
    options: [0],
    custom: true,
    text: "其他",
  });
  await expect(page.locator(".ask-user-form")).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("ask-user:ask-one")),
  ).toBeNull();
  expect(errors).toEqual([]);
});

test("questionnaire previews survive selections and review displays partial answers", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-preview",
        kind: "ask_user_question",
        questions: [
          {
            header: "方案",
            question: "选择方案",
            options: [
              { label: "A", description: "甲", preview: "**预览正文**" },
              { label: "B", description: "乙" },
            ],
          },
          {
            header: "补充",
            question: "还有什么？",
            options: [
              { label: "C", description: "丙" },
              { label: "D", description: "丁" },
            ],
          },
        ],
      },
    ],
  });
  await open(page, web);
  await page.locator(".ask-preview summary").click();
  await page.locator('[data-ask-option="0"]').check();
  await expect(page.locator(".ask-preview")).toHaveAttribute("open", "");
  await expect(page.locator(".ask-preview")).toContainText("预览正文");
  await page.getByRole("button", { name: "核对与提交" }).click();
  await expect(page.locator(".ask-review").first()).toContainText("A");
  await expect(page.locator(".ask-warning")).toContainText("尚未回答：补充");
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft[1].kind).toBe("unanswered");
});

test("generic request shows explanation and can cancel without an undefined protocol field", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "confirm-one",
        kind: "confirm",
        title: "确认",
        text: "这是需要用户确认的正文",
      },
    ],
  });
  await open(page, web);
  await expect(page.locator("#plugin-requests")).toContainText(
    "这是需要用户确认的正文",
  );
  await page.locator('[data-reply="cancel"]').click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0]).toEqual({
    type: "dialog_response",
    sessionId: "session-browser",
    id: "confirm-one",
    cancel: true,
  });
});

test("custom terminal mirrors text, sends keys to its request and disposes when removed", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "custom-one",
        sessionId: "session-browser",
        kind: "custom",
        title: "终端选择",
        columns: 120,
        lines: ["\u001b[32m请选择\u001b[0m", "A / B"],
      },
    ],
  });
  const errors = await open(page, web);
  await expect(page.locator(".terminal-screen .xterm")).toBeVisible();
  await page.locator(".terminal-host").click();
  await page.keyboard.type("ab");
  await expect
    .poll(() => web.actions.map((action) => action.value).join(""))
    .toBe("ab");
  expect(
    web.actions.every(
      (action) =>
        action.sessionId === "session-browser" && action.id === "custom-one",
    ),
  ).toBe(true);
  web.publish({ requests: [] });
  await expect(page.locator(".terminal-screen")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("narrow viewport retains a fixed composer and a single message scroller", async ({
  page,
  web,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page, web);
  await expect(page.locator("#composer")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    body: document.documentElement.scrollHeight,
    viewport: innerHeight,
    composer: document.querySelector("#composer").getBoundingClientRect()
      .bottom,
    scroll: getComputedStyle(document.querySelector("#scroll")).overflowY,
  }));
  expect(geometry.body).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.composer).toBeLessThanOrEqual(geometry.viewport);
  expect(["auto", "scroll"]).toContain(geometry.scroll);
  await page.locator("#prompt").fill("/session");
  await page.locator("#prompt").press("Enter");
  await expect(page.locator("#status-popover")).toBeVisible();
});

test("tool input, progress and final result share one card with final timing", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      {
        id: "call-message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-one",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
      },
    ],
    tools: [
      {
        toolCallId: "call-one",
        toolName: "read",
        args: { path: "README.md" },
        startedAt: Date.now() - 2000,
      },
    ],
  });
  const errors = await open(page, web);
  await expect(page.locator(".tool-block")).toHaveCount(1);
  await expect(page.locator(".tool-block")).toHaveClass(/disclosure-block/);
  // 中间过程默认收进按轮折叠块，先展开这一轮再操作卡片
  await expect(page.locator(".turn-group > summary")).toHaveCount(1);
  await page.locator(".turn-group > summary").click();
  await page.locator(".tool-block summary").click();
  await expect(page.locator(".tool-block .code-source code")).toContainText(
    "README.md",
  );
  web.publish({
    tools: [
      {
        toolCallId: "call-one",
        toolName: "read",
        args: { path: "README.md" },
        startedAt: Date.now() - 2000,
        partialResult: "正在读取",
      },
    ],
  });
  await expect(page.locator(".tool-output-frame")).toContainText("正在读取");
  web.publish({
    messages: [
      ...fixture().messages,
      {
        id: "call-message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-one",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
      },
      {
        id: "result-entity",
        role: "toolResult",
        toolCallId: "call-one",
        toolName: "read",
        content: [{ type: "text", text: "读取完成" }],
        isError: false,
      },
    ],
    tools: [],
    toolTimings: {
      "call-one": { startedAt: 1000, endedAt: 3500, durationMs: 2500 },
    },
  });
  await expect(page.locator(".tool-block")).toHaveCount(1);
  await expect(page.locator(".tool-block")).toHaveClass(/tool-success/);
  await expect(page.locator(".tool-output-frame")).toContainText("读取完成");
  await expect(page.locator(".tool-duration .duration-expanded")).toContainText(
    "2s 500ms",
  );
  expect(errors).toEqual([]);
});

test("skill reads render as a purple skill card with the skill name", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      {
        id: "skill-message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-skill",
            name: "read",
            arguments: { path: ".agents/skills/pi-vue-nobuild/SKILL.md" },
          },
          {
            type: "toolCall",
            id: "call-plain",
            name: "read",
            arguments: { path: "web/main.js" },
          },
        ],
      },
    ],
    tools: [],
  });
  const errors = await open(page, web);
  await expect(page.locator(".tool-block")).toHaveCount(2);

  const skill = page.locator(".tool-block.tool-skill");
  await expect(skill).toHaveCount(1);
  await expect(skill.locator(".tool-title strong")).toHaveText("skill");
  await expect(skill.locator(".tool-title span")).toHaveText("pi-vue-nobuild");

  // 整卡紫色：卡片配色变量与标题颜色都必须和普通 read 不同，且为紫色系（蓝 > 绿）。
  const colors = await page.evaluate(() => {
    const read = (selector) => {
      const card = document.querySelector(selector);
      return {
        state: getComputedStyle(card).getPropertyValue("--tool-state").trim(),
        title: getComputedStyle(card.querySelector("summary")).color,
      };
    };
    return {
      skill: read(".tool-block.tool-skill"),
      plain: read(".tool-block:not(.tool-skill)"),
    };
  });
  expect(colors.skill.state).not.toBe(colors.plain.state);
  expect(colors.skill.title).not.toBe(colors.plain.title);
  const rgb = colors.skill.title.match(/\d+/g).map(Number);
  expect(rgb[2]).toBeGreaterThan(rgb[1]);
  expect(errors).toEqual([]);
});

test("turn groups collapse the middle steps and stay collapsed while streaming", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      { id: "turn-u1", role: "user", content: "第一轮问题" },
      {
        id: "turn-a1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读一下" },
          { type: "toolCall", id: "call-turn", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        id: "turn-r1",
        role: "toolResult",
        toolCallId: "call-turn",
        content: [{ type: "text", text: "out" }],
        isError: false,
      },
      {
        id: "turn-a2",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "收尾" },
          { type: "text", text: "最终答案" },
        ],
      },
    ],
    tools: [],
    liveMessage: { id: "live-turn", role: "assistant", content: "正在生成" },
  });
  const errors = await open(page, web);
  const group = page.locator(".turn-group");
  await expect(group).toHaveCount(1);  await expect(group.locator(".turn-title")).toHaveText(
    "2 次思考过程 · 1 次工具调用",
  );
  // 即使会话仍在生成，也一律保持收起
  await expect(group).not.toHaveAttribute("open", "");
  // 最终输出留在折叠块之外
  await expect(page.locator("#message-history > .message").last()).toContainText(
    "最终答案",
  );
  await page.locator(".turn-group > summary").click();
  await expect(group).toHaveAttribute("open", "");
  await expect(group.locator(".thinking-block").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("untouched Thinking collapses on completion and code blocks keep copyable source separate", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    liveMessage: {
      id: "auto-thinking",
      role: "assistant",
      content: [{ type: "thinking", thinking: "自动折叠内容" }],
    },
  });
  await open(page, web);
  await expect(page.locator(".thinking-block")).toHaveClass(/disclosure-block/);
  await expect(page.locator(".thinking-block")).toHaveAttribute("open", "");
  web.publish({
    liveMessage: null,
    messages: [
      ...fixture().messages,
      {
        id: "finished-thinking",
        liveId: "auto-thinking",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "自动折叠内容" },
          { type: "text", text: '```json\n{"ready":true}\n```' },
        ],
      },
    ],
  });
  await expect(page.locator(".thinking-block")).not.toHaveAttribute("open", "");
  await expect(page.locator(".code-block .code-source code")).toHaveText(
    '{"ready":true}',
  );
  await expect(page.locator(".code-block .code-lines")).toHaveText("1");
});

test("streaming updates preserve historical node identity and input focus", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.locator("#message-history").evaluate((node) => {
    window.__historyNode = node.firstElementChild;
  });
  await page.locator("#prompt").focus();
  web.publish({
    liveMessage: { id: "run-1", role: "assistant", content: "第一段" },
  });
  await expect(page.locator("#message-live")).toContainText("第一段");
  web.publish({
    liveMessage: { id: "run-1", role: "assistant", content: "第一段第二段" },
  });
  await expect(page.locator("#message-live")).toContainText("第二段");
  await expect(page.locator("#prompt")).toBeFocused();
  await expect(
    page
      .locator("#message-history")
      .evaluate((node) => node.firstElementChild === window.__historyNode),
  ).resolves.toBe(true);
});

test("manual upward scroll immediately pauses following until returning to bottom", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.locator("#messages").evaluate((node) => {
    node.style.minHeight = "2400px";
  });
  await page.locator("#scroll").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator("#jump-to-bottom")).toHaveCount(0);

  const pausedTop = await page.locator("#scroll").evaluate((node) => {
    node.scrollTop -= 2;
    return node.scrollTop;
  });
  await expect(page.locator("#jump-to-bottom")).toBeVisible();

  web.publish({
    liveMessage: { id: "scroll-follow", role: "assistant", content: "新增流式内容" },
  });
  await expect(page.locator("#message-live")).toContainText("新增流式内容");
  await expect
    .poll(() => page.locator("#scroll").evaluate((node) => node.scrollTop))
    .toBe(pausedTop);

  await page.locator("#jump-to-bottom").click();
  await expect(page.locator("#jump-to-bottom")).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator("#scroll").evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
});

test("submitted prompt appears before model response and delayed waiting status clears on response", async ({
  page,
  web,
}) => {
  web.setActionHandler(async (action, server) => {
    if (action.type !== "send") return {};
    await new Promise((resolve) => setTimeout(resolve, 350));
    server.publish({
      pendingUserMessages: [
        { id: "pending-prompt", role: "user", content: action.text },
      ],
      responseWaitStartedAt: Date.now(),
    });
    return {};
  });
  await open(page, web);
  await page.locator("#prompt").fill("需要立即显示的消息");
  await page.locator("#send").click();

  await expect(page.locator("#message-live .message.user")).toContainText(
    "需要立即显示的消息",
    { timeout: 150 },
  );
  await expect(page.locator(".response-waiting")).toHaveCount(0);
  await expect(page.locator(".response-waiting")).toContainText(
    /正在等待模型响应\.\.\. \([12]s\)/,
    { timeout: 2500 },
  );

  web.publish({
    pendingUserMessages: [],
    responseWaitStartedAt: null,
    liveMessage: { id: "assistant-start", role: "assistant", content: "开始" },
  });
  await expect(page.locator(".response-waiting")).toHaveCount(0);
  await expect(page.locator("#message-live")).toContainText("开始");

  web.setActionHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    throw new Error("发送失败");
  });
  await page.locator("#prompt").fill("失败时撤销的消息");
  await page.locator("#send").click();
  await expect(page.locator("#message-live .message.user")).toContainText(
    "失败时撤销的消息",
    { timeout: 150 },
  );
  await expect(page.locator("#message-live .message.user")).toHaveCount(0);
});

test("images can be selected, pasted and dropped into a thumbnail strip above the user bubble", async ({
  page,
  web,
}) => {
  await open(page, web);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await expect(page.locator("#image-button")).toBeVisible();
  await page.locator(".image-input").setInputFiles({ name: "selected.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await page.locator(".image-attachment .image-preview-trigger").click();
  await expect(page.locator(".image-preview-overlay")).toBeVisible();
  await expect(page.locator(".image-preview-full")).toHaveAttribute("alt", "selected.png");
  await page.keyboard.press("Escape");
  await expect(page.locator(".image-preview-overlay")).toHaveCount(0);
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png.toString("base64"));
  await expect(page.locator(".image-attachment")).toHaveCount(2);
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, png.toString("base64"));
  await expect(page.locator(".image-attachment")).toHaveCount(3);
  await page.locator("#prompt").fill("图片说明");
  await expect(page.locator("#send")).toBeEnabled();
  await page.locator("#send").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].text).toBe("图片说明");
  expect(web.actions[0].images).toHaveLength(3);
  expect(web.actions[0].images.every((image) => image.mimeType === "image/png")).toBe(true);
  await expect(page.locator("#message-live .message.user .message-image")).toHaveCount(3);
  await expect(page.locator("#message-live .user-image-strip")).toBeVisible();
  await expect(page.locator("#message-live .user-bubble")).toContainText("图片说明");
  const sentPreview = page.locator("#message-live .user-image-strip .image-preview-trigger").first();
  await expect(sentPreview).toHaveCSS("width", "80px");
  await expect(sentPreview).toHaveCSS("height", "80px");
  await sentPreview.click();
  await expect(page.locator(".image-preview-overlay")).toBeVisible();
  await page.locator(".image-preview-close").click();
  await expect(page.locator(".image-preview-overlay")).toHaveCount(0);
});

test("manual Thinking state remains open when the live turn completes", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    liveMessage: {
      id: "run-thinking",
      role: "assistant",
      content: [{ type: "thinking", thinking: "逐步推理" }],
    },
  });
  await open(page, web);
  const thinking = page.locator("#message-live .thinking-block");
  await expect(thinking).toBeVisible();
  await thinking.locator("summary").click();
  await expect(thinking).not.toHaveAttribute("open", "");
  await thinking.locator("summary").click();
  await expect(thinking).toHaveAttribute("open", "");
  web.publish({
    liveMessage: null,
    messages: [
      ...fixture().messages,
      {
        id: "run-thinking",
        role: "assistant",
        content: [{ type: "thinking", thinking: "逐步推理" }],
      },
    ],
  });
  await expect(
    page.locator("#message-history .thinking-block"),
  ).toHaveAttribute("open", "");
});

test("model provider filter limits the selectable models", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.locator("#model-button").click();
  await page.getByRole("button", { name: "Beta" }).click();
  await expect(page.locator('[data-model-id="model-b"]')).toBeVisible();
  await expect(page.locator('[data-model-id="model-a"]')).toHaveCount(0);
});

test("composer completes commands and handles local model and session commands", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    commands: [
      { name: "help", description: "显示帮助" },
      { name: "hello", description: "问候" },
    ],
  });
  await open(page, web);
  const prompt = page.locator("#prompt");
  await prompt.fill("/he");
  await expect(page.locator("#command-menu")).toBeVisible();
  await prompt.press("ArrowDown");
  await prompt.press("Tab");
  await expect(prompt).toHaveValue("/hello ");
  await prompt.fill("/model");
  await prompt.press("Enter");
  await expect(page.locator("#model-picker")).toBeVisible();
  await prompt.fill("/session");
  await prompt.press("Enter");
  await expect(page.locator("#status-popover")).toBeVisible();
});

test("model and thinking pickers dispatch supported selections", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.locator("#model-button").click();
  await page.getByRole("button", { name: "Beta" }).click();
  await page.locator('[data-model-id="model-b"]').click();
  await page.locator("#thinking-button").click();
  await page.getByRole("button", { name: "low" }).click();
  expect(web.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "select_model",
        provider: "beta",
        modelId: "model-b",
      }),
      expect.objectContaining({ type: "select_thinking", level: "low" }),
    ]),
  );
});

test("outside click makes status and session popovers mutually exclusive", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.locator('[data-status="conversation"]').click();
  await expect(page.locator("#status-popover")).toBeVisible();
  await expect(page.locator("#status-popover")).toContainText("对话与轨迹");
  await page.locator('[data-status="session"]').click();
  await expect(page.locator("#status-popover")).toContainText("会话信息");
  await expect(page.locator('[data-status="conversation"]')).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator("#scroll").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#status-popover")).toBeHidden();
});

test("valid fragment token is retained across refresh and malformed tokens cannot replace it", async ({
  page,
  web,
}) => {
  await open(page, web);
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expect(page.locator("#message-history")).toContainText("历史消息");
  await page.goto(new URL("/#bad", web.server.url).toString());
  await expect(page.locator("#message-history")).toContainText("历史消息");
});

test("reload marker causes exactly one refresh after a replacement instance connects", async ({
  page,
  web,
}) => {
  await open(page, web);
  await page.evaluate(() =>
    sessionStorage.setItem("atom-refresh-after-reload", "instance-browser-a"),
  );
  let reloads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads++;
  });
  await web.restart({ instanceId: "instance-browser-b" });
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("atom-refresh-after-reload")),
    )
    .toBeNull();
  await page.waitForTimeout(250);
  expect(reloads).toBe(1);
});

test("composer dock stays aligned with the message column when a scrollbar takes layout space", async ({
  page,
  web,
}) => {
  await open(page, web);
  // 同一帧内设置并测量：应用自身的 ResizeObserver 会把变量恢复为真实滚动条宽度，
  // 异步读取会被覆盖回无滚动条状态。
  const result = await page.evaluate(() => {
    const center = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return +((box.left + box.right) / 2).toFixed(2);
    };
    const read = () => ({
      messages: center("#messages"),
      dock: center(".compose-wrap"),
      status: center(".status-shell"),
    });
    const before = read();
    const initialVar = getComputedStyle(document.documentElement)
      .getPropertyValue("--scrollbar-width")
      .trim();
    // 模拟经典滚动条占用 15px：dock 与状态栏必须左移半个滚动条才能继续与消息列对齐。
    document.querySelector("main").style.paddingRight = "15px";
    document.documentElement.style.setProperty("--scrollbar-width", "15px");
    const after = read();
    return { before, after, initialVar };
  });

  expect(result.before.dock).toBeCloseTo(result.before.messages, 1);
  expect(result.before.status).toBeCloseTo(result.before.messages, 1);
  // 无滚动条时变量已由 ChatView 写入。
  expect(result.initialVar).toBe("0px");

  expect(result.after.dock).toBeCloseTo(result.after.messages, 1);
  expect(result.after.status).toBeCloseTo(result.after.messages, 1);
  expect(result.before.dock - result.after.dock).toBeCloseTo(7.5, 1);

  // 变量由 ChatView 按真实滚动条宽度维护：改动 #scroll 内容盒后，观察器会用真实测量值
  // （Headless 是覆盖式滚动条，因此为 0px）覆盖上面手写的 15px。
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--scrollbar-width")
          .trim(),
      ),
    )
    .toBe("0px");
});

test("content column resizes from the edge handle, follows the pointer and is remembered", async ({
  page,
  web,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, web);

  const contentWidth = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--content-width")
        .trim(),
    );
  const list = page.locator("#messages");
  const columnWidth = () =>
    list.evaluate((element) => element.getBoundingClientRect().width);
  const handle = page.locator(".column-resizer-handle");
  const right = page.locator('.column-resizer-zone[data-side="right"]');

  expect(await contentWidth()).toBe("860px");
  await expect(page.locator(".column-resizer-zone")).toHaveCount(2);
  await expect(handle).not.toHaveClass(/is-visible/);

  // hover 右边界：手柄出现在鼠标高度，并随鼠标上下移动。
  let box = await right.boundingBox();
  const edgeX = Math.round(box.x + box.width / 2);
  await page.mouse.move(edgeX, Math.round(box.y + 80));
  await expect(handle).toHaveClass(/is-visible/);
  const high = (await handle.boundingBox()).y;
  await page.mouse.move(edgeX, Math.round(box.y + 320));
  const low = (await handle.boundingBox()).y;
  expect(low).toBeGreaterThan(high);

  // 移开鼠标后手柄隐藏。
  await page.mouse.move(24, Math.round(box.y + 320));
  await expect(handle).not.toHaveClass(/is-visible/);

  // 对称拖动：鼠标右移 120px，内容列两侧各展 120px。
  const before = await columnWidth();
  await page.mouse.move(edgeX, Math.round(box.y + 320));
  await page.mouse.down();
  await page.mouse.move(edgeX + 120, Math.round(box.y + 320), { steps: 6 });
  await expect(handle).toHaveClass(/is-active/);
  await page.mouse.up();
  expect(await contentWidth()).toBe(`${860 + 240}px`);
  expect(await columnWidth()).toBeCloseTo(before + 240, 0);
  expect(await page.evaluate(() => localStorage.getItem("atom-content-width"))).toBe(
    "1100",
  );

  // 刷新后保留，双击手柄恢复默认。
  await page.reload();
  await expect(page.locator("#message-history")).toContainText("历史消息");
  expect(await contentWidth()).toBe("1100px");
  box = await right.boundingBox();
  const resetX = Math.round(box.x + box.width / 2);
  await page.mouse.dblclick(resetX, Math.round(box.y + 160));
  expect(await contentWidth()).toBe("860px");
  expect(await page.evaluate(() => localStorage.getItem("atom-content-width"))).toBe(
    "860",
  );

  // 窄视口不提供拖动手柄。
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator(".column-resizer-zone").first()).toBeHidden();
});
