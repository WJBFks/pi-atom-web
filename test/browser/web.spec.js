import { test as base, expect } from "@playwright/test";
import { startServer } from "../../extensions/server.ts";
import {
  HISTORY_PAGE_TURNS,
  HISTORY_TURNS,
  olderHistory,
  windowedHistory,
} from "../../extensions/history-window.ts";

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
  await expect(
    page.locator(
      'link[href="/packages/@juicesharp/rpiv-ask-user-question/style.css"]',
    ),
  ).toHaveCount(0);
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

test("multi checkboxes and free text are independent stores, matching the host questionnaire", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-one",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
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
  await expect(
    page.locator(
      'link[href="/packages/@juicesharp/rpiv-ask-user-question/style.css"]',
    ),
  ).toHaveCount(1);

  // bug4（用户报告）：**先**勾自定义行、还没输入任何内容，再勾其它选项 ——
  // 自定义行自己的勾选态不能被取消（它不能由 text 反推）。
  await page.locator("[data-ask-custom]").check();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await page.locator('[data-ask-option="0"]').check();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await page.locator('[data-ask-option="0"]').uncheck();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await expect(page.locator("[data-ask-text]")).toHaveValue("");
  await page.locator("[data-ask-custom]").uncheck();

  // bug1：先勾选 A，再在自定义框输入 —— A 的勾选必须保留，且自定义行自动勾上
  await page.locator('[data-ask-option="0"]').check();
  await page.locator("[data-ask-text]").fill("其他");
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();

  // bug3：再点第二个选项，自定义行的勾选态与文本都不能被清掉
  await page.locator('[data-ask-option="1"]').check();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await expect(page.locator("[data-ask-text]")).toHaveValue("其他");

  // bug2：取消自定义行的勾选 —— 文本框内容必须保留
  await page.locator("[data-ask-custom]").uncheck();
  await expect(page.locator("[data-ask-text]")).toHaveValue("其他");
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();

  // 重新勾上自定义行后提交：文本作为额外 selected 项
  await page.locator("[data-ask-custom]").check();
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft[0]).toMatchObject({
    kind: "multi",
    options: [0, 1],
    custom: true,
    text: "其他",
  });
  await expect(page.locator(".ask-user-form")).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("ask-user:ask-one")),
  ).toBeNull();
  expect(errors).toEqual([]);
});

test("clearing every checkbox returns the multi question to unanswered", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-clear",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
        kind: "ask_user_question",
        questions: [
          {
            header: "功能",
            question: "需要哪些功能？",
            multiSelect: true,
            options: [
              { label: "A", description: "甲" },
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
  const errors = await open(page, web);
  await page.locator('[data-ask-option="0"]').check();
  await expect(page.locator('[data-ask-tab="0"]')).toContainText("✓");
  await page.locator('[data-ask-option="0"]').uncheck();
  // 取消最后一个勾选 = 回到未答（宿主会删除该答案）， ✓ 标记随之消失
  await expect(page.locator('[data-ask-tab="0"]')).not.toContainText("✓");
  await page.locator('[data-ask-option="1"]').check();
  await page.locator('[data-ask-tab="1"]').click();
  await page.locator("[data-ask-text]").fill("自定义补充");
  await page.getByRole("button", { name: "核对与提交" }).click();
  await expect(page.locator(".ask-review").first()).toContainText("B");
  await expect(page.locator(".ask-review").nth(1)).toContainText("自定义补充");
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft).toMatchObject([
    { kind: "multi", options: [1] },
    // 第二题是单选，自由回答提交为 kind:"custom"
    { kind: "custom", text: "自定义补充" },
  ]);
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
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
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
  await page.locator("[data-ask-global-note]").fill("整个问卷的补充说明");
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft[1].kind).toBe("unanswered");
  expect(web.actions[0].value.globalNote).toBe("整个问卷的补充说明");
});

test("generic request shows explanation and can cancel without an undefined protocol field", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "confirm-one",
        sessionId: "session-browser",
        kind: "confirm",
        title: "确认",
        text: "这是需要用户确认的正文",
      },
    ],
  });
  await open(page, web);
  // 扩展请求现在展示在活动组件大框里（#plugin-requests 容器已移除）
  await expect(page.locator(".activity-panel:visible")).toContainText(
    "这是需要用户确认的正文",
  );
  await page.locator('.activity-panel:visible [data-reply="cancel"]').click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0]).toEqual({
    type: "dialog_response",
    sessionId: "session-browser",
    id: "confirm-one",
    cancel: true,
  });
});

test("single-select questionnaire submits its free-text answer as a custom answer", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-single-custom",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
        kind: "ask_user_question",
        questions: [
          {
            header: "单选",
            question: "选哪个？",
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
  // 在自由回答框里输入：应选中自定义选项
  await page.locator("[data-ask-text]").fill("我自己输入的回答");
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await expect(page.locator('[data-ask-option="0"]')).not.toBeChecked();
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  // 单选必须提交为 kind:"custom"（写成 multi 会被后端按多选校验而报错）
  expect(web.actions[0].value.draft[0]).toMatchObject({
    kind: "custom",
    text: "我自己输入的回答",
  });
  expect(errors).toEqual([]);
});

test("single-select switches between picking an option and typing a free-text answer", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-single-switch",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
        kind: "ask_user_question",
        questions: [
          {
            header: "单选",
            question: "选哪个？",
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
  // 1. 选普通选项：自定义行取消选中
  await page.locator('[data-ask-option="0"]').check();
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();
  await expect(page.locator("[data-ask-custom]")).not.toBeChecked();

  // 2. 转入自由回答：普通选项被清掉（单选语义）
  await page.locator("[data-ask-text]").fill("我的回答");
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await expect(page.locator('[data-ask-option="0"]')).not.toBeChecked();

  // 3. 再切回普通选项：自由回答取消选中，且单选 kind 回到 option
  await page.locator('[data-ask-option="1"]').check();
  await expect(page.locator('[data-ask-option="1"]')).toBeChecked();
  await expect(page.locator("[data-ask-custom]")).not.toBeChecked();
  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft[0]).toMatchObject({
    kind: "option",
    option: 1,
  });
  expect(errors).toEqual([]);
});

test("single-select preview keeps the option's line structure", async ({ page, web }) => {
  // 契约：preview 是 Markdown，但多行文本必须按行渲染，且行首缩进保持；
  // 默认 Markdown 会折叠单换行、CSS 会折叠连续空格，ASCII 布局会被压平。
  const preview = [
    "详细模式（并排预览）",
    "",
    "  选项区        │  预览区",
    "  ─────────────┼───────────",
    "  ● A 推荐方案 │  ┌─ 渲染效果 ─┐",
    "    改动最小   │  │ 代码/输出 │",
  ].join("\n");
  web.setSnapshot({
    requests: [
      {
        id: "ask-preview-lines",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
        kind: "ask_user_question",
        questions: [
          {
            header: "布局",
            question: "选哪种？",
            options: [
              { label: "A", description: "甲", preview },
              {
                label: "B",
                description: "乙",
                // 列表/引用等非段落块也要保留空白，不能只盖住 <p>
                preview: "- 第一项   带   空格\n\n> 引用里  也有   空格\n\n正常段落，恢复 单个空格。",
              },
            ],
          },
        ],
      },
    ],
  });
  const errors = await open(page, web);
  await page.locator(".ask-preview summary").first().click();
  const body = page.locator(".ask-preview").first().locator(".body");
  await expect(body).toContainText("选项区");

  const rendered = await body.evaluate((node) => {
    const lines = node.innerText.split("\n");
    return {
      lines,
      blanks: lines.filter((l) => l.trim() === "").length,
      whiteSpace: getComputedStyle(node.querySelector("p")).whiteSpace,
    };
  });
  // 硬换行让每一行都在新行上（空行把内容分成两个段落，后一段 4 行 → 3 个 <br>）
  expect(await body.locator("br").count()).toBeGreaterThanOrEqual(3);
  // 行首缩进与列对齐必须保留（否则 ASCII 布局会被压平）
  expect(rendered.whiteSpace).toBe("pre-wrap");
  expect(rendered.lines.some((l) => l.startsWith("  选项区"))).toBe(true);
  expect(rendered.lines.some((l) => l.includes("● A 推荐方案 │  ┌─ 渲染效果 ─┐"))).toBe(true);
  // 预览内容包在面板框里（与代码块同一套视觉语言）
  const box = await body.evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      background: cs.backgroundColor,
      paddingTop: cs.paddingTop,
      radius: cs.borderTopLeftRadius,
    };
  });
  expect(box.borderTopStyle).toBe("solid");
  expect(parseFloat(box.borderTopWidth)).toBeGreaterThan(0);
  expect(box.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(parseFloat(box.paddingTop)).toBeGreaterThan(0);
  expect(parseFloat(box.radius)).toBeGreaterThan(0);
  // 不能因为保留空白而多出空行（原文只有 1 个空行）
  expect(rendered.blanks).toBe(1);

  // 叶子块保留空白；容器（引用/松散列表项）不能保留，否则内部换行会变成空行
  await page.locator(".ask-preview summary").nth(1).click();
  const listBody = page.locator(".ask-preview").nth(1).locator(".body");
  await expect(listBody).toContainText("第一项");
  const listWhitespace = await listBody.evaluate((node) => ({
    li: getComputedStyle(node.querySelector("li")).whiteSpace,
    quote: getComputedStyle(node.querySelector("blockquote")).whiteSpace,
    quoteParagraph: getComputedStyle(node.querySelector("blockquote p")).whiteSpace,
    quoteBlanks: node
      .querySelector("blockquote")
      .innerText.split("\n")
      .filter((l) => l.trim() === "").length,
    // 容器已提供内边距，内部段落不能再叠外边距（否则引用被撑高）
    quoteInnerMargin: getComputedStyle(node.querySelector("blockquote p")).marginTop,
    quoteInnerMarginBottom: getComputedStyle(node.querySelector("blockquote p")).marginBottom,
    // 预览内部块间距统一为项目 8px 节奏（浏览器默认 p 是 1em = 12px）
    paragraphMargin: getComputedStyle(node.querySelector(":scope > p")).marginTop,
    liText: node.querySelector("li").innerText,
  }));
  expect(listWhitespace.li).toBe("pre-wrap");
  // 引用是容器：自身 normal（否则内部换行会撑出空行），内容段落仍 pre-wrap
  expect(listWhitespace.quote).toBe("normal");
  expect(listWhitespace.quoteParagraph).toBe("pre-wrap");
  // 容器里不能出现空行（之前的 bug：引用被撑到 6 个空行）
  expect(listWhitespace.quoteBlanks).toBe(0);
  // 引用不能被内部段落的外边距撑高
  expect(listWhitespace.quoteInnerMargin).toBe("0px");
  expect(listWhitespace.quoteInnerMarginBottom).toBe("0px");
  expect(listWhitespace.paragraphMargin).toBe("8px");
  expect(listWhitespace.liText).toContain("第一项   带   空格");
  expect(errors).toEqual([]);
});

test("switching tabs keeps every question's draft intact", async ({ page, web }) => {
  web.setSnapshot({
    requests: [
      {
        id: "ask-tabs",
        sessionId: "session-browser",
        packageId: "@juicesharp/rpiv-ask-user-question",
        kind: "ask_user_question",
        questions: [
          {
            header: "多选",
            question: "需要哪些功能？",
            multiSelect: true,
            options: [
              { label: "A", description: "甲" },
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
  const errors = await open(page, web);

  // 第 1 题：勾选 + 自由文本都填上
  await page.locator('[data-ask-option="0"]').check();
  await page.locator("[data-ask-text]").fill("第一题的自由回答");
  await expect(page.locator('[data-ask-tab="0"]')).toContainText("✓");

  // 切到第 2 题、作答、再切回来
  await page.locator('[data-ask-tab="1"]').click();
  await expect(page.locator(".ask-title")).toHaveText("补充");
  await page.locator('[data-ask-option="1"]').check();
  await expect(page.locator('[data-ask-tab="1"]')).toContainText("✓");
  await page.locator('[data-ask-tab="0"]').click();

  // 第 1 题的全部输入必须原样保留（勾选、自定义勾选、文本）
  await expect(page.locator(".ask-title")).toHaveText("多选");
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();
  await expect(page.locator("[data-ask-custom]")).toBeChecked();
  await expect(page.locator("[data-ask-text]")).toHaveValue("第一题的自由回答");

  // 核对页应同时展示两题的答案
  await page.getByRole("button", { name: "核对与提交" }).click();
  await expect(page.locator(".ask-review").first()).toContainText("A");
  await expect(page.locator(".ask-review").first()).toContainText("第一题的自由回答");
  await expect(page.locator(".ask-review").nth(1)).toContainText("D");

  await page.locator("[data-ask-submit]").click();
  await expect.poll(() => web.actions.length).toBe(1);
  expect(web.actions[0].value.draft).toMatchObject([
    { kind: "multi", options: [0], custom: true, text: "第一题的自由回答" },
    { kind: "option", option: 1 },
  ]);
  expect(errors).toEqual([]);
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
  // 展开工具卡：直接改 DOM，不受它是否被按轮折叠块收起影响
  await page.locator(".tool-block").first().evaluate((node) => {
    node.open = true;
  });
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

test("generic tools use JSON input and unframed Markdown output without nested vertical scrolling", async ({ page, web }) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      { id: "generic-call", role: "assistant", content: [{
        type: "toolCall", id: "generic-one", name: "ctx_execute",
        arguments: { code: "const answer = 42" },
      }] },
      { id: "generic-result", role: "toolResult", toolCallId: "generic-one", toolName: "ctx_execute",
        content: [{ type: "text", text: "## Result\n\n```js\nconst answer = 42;\n```" }] },
    ],
  });
  await open(page, web);
  const tool = page.locator(".tool-block").filter({ hasText: /^ctx_execute/ });
  await tool.evaluate((node) => { node.closest(".turn-group").open = true; node.open = true; });
  await expect(tool.locator(".tool-panel")).toHaveCount(0);
  await expect(tool.locator(".tool-output-frame")).toHaveCount(0);
  await expect(tool.locator(".tool-io-section").first().locator(".code-header")).toContainText("json");
  await expect(tool.locator(".tool-output-markdown h2")).toHaveText("Result");
  const style = await tool.locator(".tool-output-markdown .code-scroll").evaluate((node) => ({
    maxHeight: getComputedStyle(node).maxHeight,
    hasVerticalOverflow: node.scrollHeight > node.clientHeight,
    background: getComputedStyle(node).backgroundColor,
  }));
  expect(style.maxHeight).toBe("none");
  expect(style.hasVerticalOverflow).toBe(false);
});

test("skill reads render as a normal grey card with the skill name", async ({
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
  await expect(skill.locator(".disclosure-separator")).toHaveText("·");
  await expect(skill.locator(".tool-title > span:last-child")).toHaveText("pi-vue-nobuild");
  await skill.evaluate((node) => {
    const group = node.closest(".turn-group");
    if (group) group.open = true;
  });
  // 图标/三角有 120ms 过渡，读取计算样式前等它稳定
  await page.waitForTimeout(250);
  await skill.locator(":scope > summary").hover();
  // hover 会触发 120ms 过渡，用带重试的断言等它结束，避免读到中间值
  await expect(skill.locator(".disclosure-type-icon")).toHaveCSS("opacity", "0");
  await expect(skill.locator(".disclosure-caret")).toHaveCSS("opacity", "1");
  await skill.locator(":scope > summary").click();
  // 展开时只有「思考」块会隐藏分隔点，工具卡保留它
  await expect(skill.locator(".disclosure-separator")).toBeVisible();
  const alignment = await skill.locator(":scope > summary").evaluate((summary) => {
    const icon = summary.querySelector(".disclosure-icon").getBoundingClientRect();
    const title = summary.querySelector(".tool-title").getBoundingClientRect();
    return Math.abs(icon.top + icon.height / 2 - (title.top + title.height / 2));
  });
  expect(alignment).toBeLessThanOrEqual(1);

  // 统一状态色：技能卡不再单独着色，与普通 read 同为「正常」灰色。
  const colors = await page.evaluate(() => {
    const read = (selector) => {
      const card = document.querySelector(selector);
      return {
        title: getComputedStyle(card.querySelector("summary")).color,
        icon: getComputedStyle(card.querySelector(".disclosure-icon")).color,
      };
    };
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--muted");
    document.body.appendChild(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return {
      muted,
      skill: read(".tool-block.tool-skill"),
      plain: read(".tool-block:not(.tool-skill)"),
    };
  });
  expect(colors.skill.icon).toBe(colors.plain.icon);
  expect(colors.skill.title).toBe(colors.plain.title);
  expect(colors.skill.icon).toBe(colors.muted);
  expect(colors.skill.title).toBe(colors.muted);
  expect(errors).toEqual([]);
});

test("collapsible blocks keep grey normally and turn the whole summary red on error", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      {
        id: "state-call",
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-ok", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "call-bad", name: "read", arguments: { path: "missing.md" } },
        ],
      },
      {
        id: "state-ok",
        role: "toolResult",
        toolCallId: "call-ok",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      {
        id: "state-bad",
        role: "toolResult",
        toolCallId: "call-bad",
        toolName: "read",
        content: [{ type: "text", text: "ENOENT" }],
        isError: true,
      },
      { id: "notice-info", role: "notification", level: "info", content: "普通通知内容" },
      { id: "notice-warn", role: "notification", level: "warning", content: "警告通知内容" },
      { id: "notice-error", role: "notification", level: "error", content: "错误通知内容" },
    ],
    tools: [],
  });
  const errors = await open(page, web);
  const palette = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    const read = (name) => {
      probe.style.color = root.getPropertyValue(name);
      return getComputedStyle(probe).color;
    };
    const out = {
      muted: read("--muted"),
      preview: read("--summary-preview"),
      failure: read("--tool-failure"),
      running: read("--tool-running"),
    };
    probe.remove();
    return out;
  });
  const summaryParts = async (selector) => {
    const summary = page.locator(selector).locator(":scope > summary");
    await expect(summary).toHaveCount(1);
    return summary.evaluate((node) => ({
      all: [node, ...node.querySelectorAll("*")].map((n) => getComputedStyle(n).color),
      title: [node.querySelector(".disclosure-icon"), node.querySelector("strong")]
        .filter(Boolean)
        .map((n) => getComputedStyle(n).color),
      preview: [...node.querySelectorAll(".disclosure-preview, .tool-title > span:not(.disclosure-separator)")]
        .map((n) => getComputedStyle(n).color),
    }));
  };
  const expectUniform = (parts, expected) => {
    expect(parts.all.length).toBeGreaterThan(3);
    parts.all.forEach((color) => expect(color).toBe(expected));
  };
  const expectParts = (parts, title, preview) => {
    expect(parts.all.length).toBeGreaterThan(3);
    parts.title.forEach((color) => expect(color).toBe(title));
    expect(parts.preview.length).toBeGreaterThan(0);
    parts.preview.forEach((color) => expect(color).toBe(preview));
  };

  // 正常：图标与标题为普通灰，单行摘要用更浅的 --summary-preview
  expectParts(await summaryParts(".tool-block.tool-success"), palette.muted, palette.preview);
  expectParts(await summaryParts('[data-notification="info"]'), palette.muted, palette.preview);
  // 警告 = 橙色（通知 warning），整行同色
  expectUniform(await summaryParts('[data-notification="warning"]'), palette.running);
  // 报错 = 红色，整行（图标、标题、摘要、耗时）统一标红
  expectUniform(await summaryParts(".tool-block.tool-failure"), palette.failure);
  expectUniform(await summaryParts('[data-notification="error"]'), palette.failure);
  expect(errors).toEqual([]);
});

test("turn groups stay open after the turn ends and fold on the next user input", async ({
  page,
  web,
}) => {
  const turnMessages = [
    ...fixture().messages,
    { id: "turn-u1", role: "user", content: "第一轮问题" },
    {
      id: "turn-a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读一下" },
        { type: "text", text: "中间说明" },
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
  ];
  web.setSnapshot({
    messages: turnMessages,
    tools: [],
    busy: true,
    liveMessage: { id: "live-turn", role: "assistant", content: "正在生成" },
  });
  const errors = await open(page, web);
  const group = page.locator(".turn-group");
  await expect(group).toHaveCount(1);  await expect(group.locator(".turn-title")).toHaveText(
    "2 次思考过程 · 1 次工具调用 · 1 条消息",
  );
  // 执行中默认展开：折叠区里的卡片可见
  await expect(group).toHaveAttribute("open", "");
  await expect(group.locator(".thinking-block").first()).toBeVisible();
  // 折叠区里的中间消息与最终输出同款排版（字号/行高一致）
  const sizes = await page.evaluate(() => {
    const read = (el) => {
      const style = getComputedStyle(el);
      return [style.fontSize, style.lineHeight];
    };
    const inner = [...document.querySelectorAll(".turn-group .disclosure-body > .message")].find(
      (message) => message.textContent.includes("中间说明"),
    );
    const final = [...document.querySelectorAll("#message-history > .message")].find(
      (message) => message.textContent.includes("最终答案"),
    );
    return { inner: read(inner), final: read(final) };
  });
  expect(sizes.inner).toEqual(sizes.final);
  // 最终输出留在折叠块之外
  await expect(page.locator("#message-history > .message").last()).toContainText(
    "最终答案",
  );
  // 流式消息结束、会话也不再工作时，仍然保持展开（折叠时机已改为下一个用户输入）
  web.publish({ liveMessage: null, tools: [], busy: true });
  await expect(group).toHaveAttribute("open", "");
  web.publish({ busy: false });
  await expect(group).toHaveAttribute("open", "");

  // 下一个用户输入开始 → 自动折叠
  web.publish({
    messages: [
      ...turnMessages,
      { id: "turn-u2", role: "user", content: "第二轮问题" },
    ],
  });
  await expect(group).not.toHaveAttribute("open", "");

  // 用户手动展开过 → 再下一个用户输入也不再自动折叠
  await page.locator(".turn-group > summary").click();
  await expect(group).toHaveAttribute("open", "");
  web.publish({
    messages: [
      ...turnMessages,
      { id: "turn-u2", role: "user", content: "第二轮问题" },
      { id: "turn-u3", role: "user", content: "第三轮问题" },
    ],
  });
  await expect(group).toHaveAttribute("open", "");
  await expect(group.locator(".thinking-block").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("turning off auto collapse keeps middle steps open past the next user input", async ({
  page,
  web,
}) => {
  const messages = [
    ...fixture().messages,
    { id: "auto-u1", role: "user", content: "问题" },
    {
      id: "auto-a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考" },
        { type: "toolCall", id: "call-auto", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { id: "auto-r1", role: "toolResult", toolCallId: "call-auto", content: [{ type: "text", text: "out" }] },
    { id: "auto-a2", role: "assistant", content: [{ type: "text", text: "答案" }] },
    { id: "auto-u2", role: "user", content: "下一个问题" },
  ];
  web.setSnapshot({ messages });
  await open(page, web);
  const group = page.locator(".turn-group");
  await expect(group).toHaveCount(1);
  // 默认：下一个用户输入开始后就折叠
  await expect(group).not.toHaveAttribute("open", "");

  // 关闭自动折叠后，即使已有下一个用户输入也保持展开
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-section="behaviour"]').click();
  await page.locator('[data-toggle="自动折叠中间过程"]').uncheck();
  await page.locator('[data-view="chat"]').click();
  await expect(group).toHaveAttribute("open", "");
});

test("a new thinking block folds the previous one, and the reply end folds the rest", async ({
  page,
  web,
}) => {
  const content = [
    { type: "thinking", thinking: "第一段思考" },
    { type: "toolCall", id: "call-think", name: "bash", arguments: { command: "ls" } },
    { type: "thinking", thinking: "第二段思考" },
  ];
  web.setSnapshot({
    liveMessage: { id: "multi-thinking", role: "assistant", content: [content[0]] },
  });
  await open(page, web);
  const blocks = page.locator(".thinking-block");
  await expect(blocks).toHaveCount(1);
  await expect(blocks.nth(0)).toHaveAttribute("open", "");

  // 第二个思考块开始 → 前一个立刻折叠，最后一个保持展开
  web.publish({
    liveMessage: { id: "multi-thinking", role: "assistant", content },
  });
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).not.toHaveAttribute("open", "");
  await expect(blocks.nth(1)).toHaveAttribute("open", "");

  // 全部回话结束（消息离开 live 区）→ 最后一个也折叠
  web.publish({
    liveMessage: null,
    messages: [
      ...fixture().messages,
      {
        id: "finished-multi",
        liveId: "multi-thinking",
        role: "assistant",
        content: [...content, { type: "text", text: "答案" }],
      },
    ],
  });
  await expect(blocks.nth(0)).not.toHaveAttribute("open", "");
  await expect(blocks.nth(1)).not.toHaveAttribute("open", "");
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
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#jump-to-bottom")).toHaveCount(0);

  const pausedTop = await page.locator("#scroll").evaluate((node) => {
    node.scrollTop -= 2;
    node.dispatchEvent(new Event("scroll"));
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

  await expect(page.locator("#prompt")).toHaveValue("", { timeout: 100 });

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
  await expect(page.locator("#prompt")).toHaveValue("失败时撤销的消息");
});

test("busy prompt clears immediately and appears only in the follow-up queue", async ({
  page,
  web,
}) => {
  const queue = { revision: 0, count: 0, steering: [], followUp: [] };
  web.setSnapshot({ busy: true, pending: false, promptQueue: queue });
  web.setActionHandler(async (action, server) => {
    if (action.type !== "send") return {};
    await new Promise((resolve) => setTimeout(resolve, 250));
    queue.revision += 1;
    queue.count = 1;
    queue.followUp = [
      { id: "followUp:0:busy", kind: "followUp", index: 0, text: action.text },
    ];
    server.publish({ pending: true, promptQueue: structuredClone(queue) });
    return { delivery: "queued" };
  });
  await open(page, web);
  await page.locator("#prompt").fill("只进入排队的消息");
  await page.locator("#send").click();

  await expect(page.locator("#prompt")).toHaveValue("", { timeout: 100 });
  await expect(page.locator("#message-live .message.user")).toHaveCount(0);
  await expect(page.locator('[data-activity-tab="prompt-queue"]')).toContainText("队列 1");
  await page.locator('[data-activity-tab="prompt-queue"]').click();
  await expect(page.locator(".prompt-queue-panel")).toContainText("只进入排队的消息");
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

test("top tabs switch between conversation, context and settings", async ({
  page,
  web,
}) => {
  await open(page, web);
  const tab = (id) => page.locator(`[data-view="${id}"]`);
  await expect(page.locator('.view-tabs [role="tab"]')).toHaveCount(4);
  await expect(tab("chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#view-panel-feed")).toBeVisible();
  await expect(page.locator("#view-panel-context")).toBeHidden();
  await expect(page.locator("#view-panel-settings")).toBeHidden();

  // 执行轨迹将改为独立页面：tab 保持可见但不可选中。
  await expect(tab("trace")).toBeDisabled();
  await tab("trace").click({ force: true });
  await expect(tab("chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#view-panel-feed")).toBeVisible();

  await tab("settings").click();
  await expect(tab("settings")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#view-panel-settings")).toBeVisible();
  await expect(page.locator("#view-panel-feed")).toBeHidden();
  // 设置页是左侧分类导航 + 右侧内容
  await expect(page.locator(".settings-nav [role='tab']")).toHaveCount(4);
  for (const label of ["外观", "会话信息", "连接与实例", "行为"])
    await expect(page.locator(".settings-nav")).toContainText(label);
  await expect(page.locator("#settings-panel")).toContainText("主题");
  await page.locator('[data-section="session"]').click();
  await expect(page.locator("#settings-panel")).toContainText("session-browser");
  await page.locator('[data-section="connection"]').click();
  await expect(page.locator("#settings-panel")).toContainText("连接凭证");
  await page.locator('[data-section="behaviour"]').click();
  await expect(page.locator("#settings-panel")).toContainText("自动折叠中间过程");

  await tab("context").click();
  await expect(page.locator("#view-panel-context")).toContainText("上下文构成");
  await expect(page.locator("#view-panel-context")).toContainText("Token 用量");

  // 键盘：焦点跟着选中项移动（跳过不可选中的轨迹）。
  await tab("chat").click();
  await tab("chat").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("context")).toHaveAttribute("aria-selected", "true");
  await expect(tab("context")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab("settings")).toHaveAttribute("aria-selected", "true");
  await tab("chat").click();
  await expect(page.locator("#message-history")).toContainText("历史消息");
});

test("switching tabs keeps the transcript laid out and its scroll position", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      ...Array.from({ length: 40 }).flatMap((_, i) => [
        { id: `bench-u${i}`, role: "user", content: `第 ${i} 轮：看看这段` },
        {
          id: `bench-a${i}`,
          role: "assistant",
          content: [
            {
              type: "text",
              text: `第 ${i} 轮结论：\`parse()\` 的第二个参数有问题。`,
            },
          ],
        },
      ]),
    ],
  });
  await open(page, web);
  const scroll = page.locator("#scroll");
  await scroll.evaluate((node) =>
    node.scrollTo({ top: Math.round(node.scrollHeight * 0.4), behavior: "instant" }),
  );
  const before = await scroll.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);

  await page.locator('[data-view="settings"]').click();
  // 消息区只切 visibility：保持布局，否则切回来要重排整段 transcript（实测 100–130ms）。
  expect(
    await page
      .locator("#view-panel-feed")
      .evaluate((node) => getComputedStyle(node).display),
  ).not.toBe("none");
  await page.locator('[data-view="chat"]').click();
  await expect(page.locator("#view-panel-feed")).toBeVisible();
  expect(await scroll.evaluate((node) => node.scrollTop)).toBe(before);
  await expect(page.locator("#message-history")).toContainText("历史消息");

  // 切页不丢草稿，dock 高度也要恢复；隐藏期间到达的历史照常进入消息区。
  await page.fill("#prompt", "未发出的草稿");
  await page.locator('[data-view="settings"]').click();
  await expect(page.locator(".compose-wrap")).toBeHidden();
  web.publish({
    messages: [
      ...fixture().messages,
      { id: "late-1", role: "user", content: "隐藏期间的问题" },
      {
        id: "late-2",
        role: "assistant",
        content: [{ type: "text", text: "隐藏期间的回答" }],
      },
    ],
  });
  await page.locator('[data-view="chat"]').click();
  await expect(page.locator("#prompt")).toHaveValue("未发出的草稿");
  await expect(page.locator("#message-history")).toContainText("隐藏期间的回答");
  await expect
    .poll(async () =>
      Number.parseFloat(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--compose-height")
            .trim(),
        ),
      ),
    )
    .toBeGreaterThan(0);
});

test("the settings tab controls theme, content width and behaviour, and remembers them", async ({
  page,
  web,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, web);
  await page.locator('[data-view="settings"]').click();
  const panel = page.locator("#view-panel-settings");

  // 主题：立即生效 + 写入 atom-theme
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await panel.locator('[data-choice="dark"]').click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(panel.locator('[data-choice="dark"]')).toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem("atom-theme"))).toBe(
    "dark",
  );

  // 内容列宽度：数值输入 + 滑块 + 右侧还原图标，与拖动列宽共用 atom-content-width
  const contentWidth = () =>
    page.evaluate(() => localStorage.getItem("atom-content-width"));
  const cssVar = (name) =>
    page.evaluate(
      (which) =>
        getComputedStyle(document.documentElement).getPropertyValue(which).trim(),
      name,
    );
  const resetWidth = page.locator('[data-reset^="还原默认宽度"]');
  await page.fill("#setting-content-width", "640");
  await page.locator("#setting-content-width").blur();
  await expect.poll(contentWidth).toBe("640");
  expect(await cssVar("--content-width")).toBe("640px");

  // 滑块：拖动（键盘步进）同样实时生效
  await page.locator("#setting-content-width-range").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(contentWidth).toBe("650");
  expect(await cssVar("--content-width")).toBe("650px");

  // 还原图标：回到默认值后自动禁用
  await expect(resetWidth).toBeEnabled();
  await resetWidth.click();
  await expect.poll(contentWidth).toBe("860");
  expect(await cssVar("--content-width")).toBe("860px");
  await expect(resetWidth).toBeDisabled();

  const stored = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("atom-settings") || "{}"));

  // 安全区：写成 --safe-area-top/-bottom，由 .layout 的 padding 消费
  const safeArea = (side) => cssVar(side);
  await page.fill("#setting-safe-area-top", "24");
  await page.locator("#setting-safe-area-top").blur();
  await page.locator("#setting-safe-area-bottom-range").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => safeArea("--safe-area-bottom")).toBe("1px");
  await page.fill("#setting-safe-area-bottom", "12");
  await page.locator("#setting-safe-area-bottom").blur();
  await expect.poll(() => safeArea("--safe-area-top")).toBe("24px");
  expect(await safeArea("--safe-area-bottom")).toBe("12px");
  expect(
    await page
      .locator(".layout")
      .evaluate((node) => getComputedStyle(node).paddingTop),
  ).toBe("24px");
  expect(
    await page
      .locator(".layout")
      .evaluate((node) => getComputedStyle(node).paddingBottom),
  ).toBe("12px");
  await expect.poll(async () => (await stored()).safeAreaBottom).toBe(12);

  // 顶部安全区的还原图标
  const resetTop = page.locator('[data-reset="还原顶部安全区"]');
  await expect(resetTop).toBeEnabled();
  await resetTop.click();
  await expect.poll(() => safeArea("--safe-area-top")).toBe("0px");
  await expect(resetTop).toBeDisabled();

  // 折叠与跟随开关写入 atom-settings（在左侧「行为」分类里）
  await panel.locator('[data-section="behaviour"]').click();
  await page.locator('[data-toggle="自动折叠中间过程"]').uncheck();
  await page.locator('[data-toggle="自动跟随最新消息"]').uncheck();
  await expect.poll(async () => (await stored()).autoCollapse).toBe(false);
  expect((await stored()).autoFollow).toBe(false);

  // 默认视图：重新载入后落在上下文页，主题与开关保持
  await panel.locator('[data-choice="context"]').click();
  await page.reload();
  await expect(page.locator("#message-history")).toContainText("历史消息");
  await expect(page.locator('[data-view="context"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("html")).toHaveClass(/dark/);
  // 安全区随刷新保持
  expect(await cssVar("--safe-area-bottom")).toBe("12px");
  expect(
    await page
      .locator(".layout")
      .evaluate((node) => getComputedStyle(node).paddingBottom),
  ).toBe("12px");
});

test("context and settings pages hide the composer dock", async ({
  page,
  web,
}) => {
  await open(page, web);
  const dock = page.locator(".compose-wrap");
  const composeHeight = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--compose-height")
        .trim(),
    );
  await expect(dock).toBeVisible();
  expect(Number.parseFloat(await composeHeight())).toBeGreaterThan(0);

  await page.locator('[data-view="settings"]').click();
  await expect(dock).toBeHidden();
  // dock 不占位：ResizeObserver 会把高度写成 0，页面底部留白随之收缩。
  await expect.poll(composeHeight).toBe("0px");
  expect(
    await page
      .locator(".settings-page")
      .evaluate((node) => getComputedStyle(node).paddingBottom),
  ).toBe("20px");

  await page.locator('[data-view="context"]').click();
  await expect(dock).toBeHidden();

  await page.locator('[data-view="chat"]').click();
  await expect(dock).toBeVisible();
  await expect
    .poll(async () => Number.parseFloat(await composeHeight()))
    .toBeGreaterThan(0);
});

test.describe("touch device", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the bottom safe area yields while an input is focused", async ({
    page,
    web,
  }) => {
    const bottom = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--safe-area-bottom")
          .trim(),
      );
    await open(page, web);
    await page.locator('[data-view="settings"]').click();
    await page.fill("#setting-safe-area-bottom", "24");
    await page.locator("#setting-safe-area-bottom").blur();
    await expect.poll(bottom).toBe("24px");
    await page.locator('[data-view="chat"]').click();
    await expect(page.locator("#prompt")).toBeVisible();

    // 手机上点到输入框（软键盘弹出）→ 底部安全区让位
    await page.locator("#prompt").click();
    await expect.poll(bottom).toBe("0px");
    // 配置值不变
    expect(
      JSON.parse(
        await page.evaluate(() => localStorage.getItem("atom-settings")),
      ).safeAreaBottom,
    ).toBe(24);

    // 失焦后恢复
    await page.locator("#prompt").blur();
    await expect.poll(bottom).toBe("24px");
  });
});

test("long sessions paint the newest turns first and load one older page near the top", async ({
  page,
  web,
}) => {
  const turns = 25;
  const turnMessages = Array.from({ length: turns }).flatMap((_, index) => [
    { id: `lazy-u${index}`, role: "user", content: `第 ${index} 轮问题` },
    {
      id: `lazy-a${index}`,
      role: "assistant",
      content: [
        { type: "thinking", text: `第 ${index} 轮思考` },
        {
          type: "toolCall",
          id: `lazy-call-${index}`,
          name: "bash",
          arguments: { command: `echo ${index}` },
        },
      ],
    },
    {
      id: `lazy-r${index}`,
      role: "toolResult",
      toolCallId: `lazy-call-${index}`,
      content: [{ type: "text", text: `第 ${index} 轮输出` }],
    },
    {
      id: `lazy-f${index}`,
      role: "assistant",
      content: [{ type: "text", text: `第 ${index} 轮结论` }],
    },
  ]);
  // 模拟后端分页：首屏只发最近 10 轮，更早的由客户端按游标向前补
  const windowed = windowedHistory(turnMessages, HISTORY_TURNS);
  web.setSnapshot({
    messages: windowed.messages,
    historyComplete: false,
    liveMessage: null,
    tools: [],
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let released = false;
  web.setActionHandler(async (action, server) => {
    if (action.type !== "more_history") return {};
    if (!released) await gate;
    const index = turnMessages.findIndex(
      (message) => String(message.id) === String(action.cursor),
    );
    if (index <= 0) {
      server.publish({ historyComplete: true });
      return { queued: true, count: 0 };
    }
    const { messages, start } = olderHistory(
      turnMessages,
      index,
      HISTORY_PAGE_TURNS,
    );
    server.publish({ prependMessages: messages, historyComplete: start === 0 });
    return { queued: true, count: messages.length };
  });

  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(new URL(`/#${token}`, web.server.url).toString());
  await expect(page.locator("#message-history")).toContainText(`第 ${turns - 1} 轮结论`);
  const initialAssets = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(initialAssets.some((url) => /\/xterm\.(?:js|css)$/.test(url))).toBe(false);
  expect(initialAssets.some((url) => /\/views\/(?:Context|Settings)View\.js$/.test(url))).toBe(false);

  // 首屏只有最近 10 轮，且已加载的中间过程全部折叠
  expect(await page.locator(".turn-group").count()).toBe(HISTORY_TURNS);
  expect(await page.locator(".turn-group[open]").count()).toBe(0);
  await expect(page.locator("#message-history")).not.toContainText("第 0 轮结论");
  // 停在底部时不应在后台连续灌入历史；滚到顶部才请求一页。
  await page.waitForTimeout(300);
  expect(web.actions.filter((action) => action.type === "more_history")).toHaveLength(0);
  await page.locator("#scroll").evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => web.actions.filter((action) => action.type === "more_history").length)
    .toBe(1);
  expect(
    web.actions.find((action) => action.type === "more_history").cursor,
  ).toBe("lazy-u15");

  // 放行单页补载：保留当前视口，不继续自动请求其余页面。
  released = true;
  release();
  await expect(page.locator("#message-history")).toContainText("第 10 轮结论");
  expect(await page.locator(".turn-group").count()).toBe(
    HISTORY_TURNS + HISTORY_PAGE_TURNS,
  );
  await page.waitForTimeout(300);
  expect(web.actions.filter((action) => action.type === "more_history")).toHaveLength(1);
  expect(await page.locator(".turn-group[open]").count()).toBe(0);
  await expect(page.locator("#message-history")).toContainText("第 24 轮结论");
  expect(failures).toEqual([]);
});

test("system tools render dedicated write content and edit diffs", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      { id: "sys-u1", role: "user", content: "改一下这个文件" },
      {
        id: "sys-w1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-write",
            name: "write",
            arguments: {
              file_path: "src/demo.ts",
              content: "export const answer = 42;\n",
            },
          },
        ],
      },
      {
        id: "sys-w2",
        role: "toolResult",
        toolCallId: "call-write",
        toolName: "write",
        content: [{ type: "text", text: "已写入 src/demo.ts" }],
      },
      {
        id: "sys-e1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-edit",
            name: "edit",
            arguments: {
              file_path: "src/demo.ts",
              oldText: "export const answer = 42;",
              newText: "export const answer = 43;",
            },
          },
        ],
      },
      {
        id: "sys-e2",
        role: "toolResult",
        toolCallId: "call-edit",
        toolName: "edit",
        content: [{ type: "text", text: "已修改 src/demo.ts" }],
        details: {
          diff: [
            " 1 export const answer = 42;",
            `-2 export const answer = 42; // ${'x'.repeat(320)}`,
            "+2 export const answer = 43;",
          ].join("\n"),
          firstChangedLine: 2,
        },
      },
    ],
  });
  const errors = await open(page, web);
  const card = (name) =>
    page
      .locator(".tool-block")
      .filter({ hasText: new RegExp(`^${name}`) })
      .first();

  // write：标题带路径，正文是推断出语言的高亮内容，原始入参收进二级折叠
  const write = card("write");
  await expect(write.locator(".tool-title")).toContainText("write");
  await expect(write.locator(".tool-title")).toContainText("src/demo.ts");
  await expect(write.locator(".code-header").first()).toContainText("typescript");
  await expect(write.locator(".code-source code").first()).toHaveText(
    "export const answer = 42;",
  );
  await expect(write.locator("details.tool-raw-input")).toHaveCount(1);
  await expect(write.locator("details.tool-raw-input")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(write.locator("details.tool-raw-input")).toContainText(
    "原始 Input",
  );
  await expect(write.locator(".tool-output-frame")).toContainText(
    "已写入 src/demo.ts",
  );

  // edit：结果带宿主算好的 diff 时按真实行号渲染
  const edit = card("edit");
  await expect(edit.locator(".tool-title")).toContainText("src/demo.ts");
  await expect(edit.locator(".diff-removed .diff-number")).toHaveText("2");
  await expect(edit.locator(".diff-added .diff-number")).toHaveText("2");
  await expect(edit.locator(".diff-removed .diff-text")).toContainText(
    "export const answer = 42;",
  );
  await expect(edit.locator(".diff-added .diff-text")).toHaveText(
    "export const answer = 43;",
  );
  await expect(edit.locator("details.tool-raw-input")).toHaveCount(1);

  // diff 整块横向滚动，行号 gutter 固定（不能每行各自滚动）
  // 折叠状态下几何量全是 0，先展开中间过程与工具卡。
  await page.locator(".turn-group > summary").first().click();
  await edit.locator("> summary").click();
  const block = edit.locator(".diff-block");
  const layout = await block.evaluate((node) => ({
    blockOverflowX: getComputedStyle(node).overflowX,
    lineOverflowX: getComputedStyle(node.querySelector(".diff-line")).overflowX,
    gutterPosition: getComputedStyle(node.querySelector(".diff-gutter")).position,
    scrollable: node.scrollWidth > node.clientWidth,
  }));
  expect(layout.blockOverflowX).toBe("auto");
  expect(layout.lineOverflowX).toBe("visible");
  expect(layout.gutterPosition).toBe("sticky");
  expect(layout.scrollable).toBe(true);
  const sticky = await block.evaluate(async (node) => {
    const gutter = node.querySelector(".diff-gutter");
    const before = Math.round(gutter.getBoundingClientRect().left);
    node.scrollLeft = node.scrollWidth;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    return {
      before,
      after: Math.round(gutter.getBoundingClientRect().left),
      scrollLeft: Math.round(node.scrollLeft),
    };
  });
  expect(sticky.scrollLeft).toBeGreaterThan(0);
  expect(sticky.after).toBe(sticky.before);
  expect(errors).toEqual([]);
});

test("read and bash results render as code and terminal output", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      { id: "rb-u1", role: "user", content: "读一下并跑个命令" },
      {
        id: "rb-a1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            arguments: { file_path: "src/demo.ts", offset: 200, limit: 2 },
          },
        ],
      },
      {
        id: "rb-r1",
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [
          {
            type: "text",
            text: "export const answer = 43;\nexport const other = 1;\n\n[246 more lines in file. Use offset=202 to continue.]",
          },
        ],
      },
      {
        id: "rb-a2",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-bash",
            name: "bash",
            arguments: { command: "printf '# not a heading\\n* not a bullet'" },
          },
        ],
      },
      {
        id: "rb-r2",
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "text", text: "# not a heading\n* not a bullet" }],
      },
      {
        id: "rb-a3",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-grep",
            name: "grep",
            arguments: { pattern: "TODO", path: "src", glob: "*.ts" },
          },
        ],
      },
      {
        id: "rb-r3",
        role: "toolResult",
        toolCallId: "call-grep",
        toolName: "grep",
        content: [
          {
            type: "text",
            text: "src/a_b.ts:12: // TODO fix *this*\nsrc/c.ts:3: // TODO",
          },
        ],
      },
    ],
  });
  const errors = await open(page, web);
  const card = (name) =>
    page
      .locator(".tool-block")
      .filter({ hasText: new RegExp(`^${name}`) })
      .first();

  // read：INPUT 是可读参数 + 原始 Input 折叠；OUTPUT 按路径语言高亮、行号从 offset 开始
  const read = card("read");
  await expect(read.locator(".tool-title")).toContainText("src/demo.ts");
  const readInput = read.locator(".tool-body > .tool-io-section").first();
  await expect(readInput.locator(".tool-io-label")).toHaveText("Input");
  await expect(readInput.locator(".tool-params dt")).toHaveText([
    "路径",
    "起始行",
    "行数",
  ]);
  await expect(readInput.locator(".tool-params dd").first()).toHaveText(
    "src/demo.ts",
  );
  // 原始 JSON 收进二级折叠（默认收起）
  await expect(readInput.locator("details.tool-raw-input")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(
    readInput.locator("details.tool-raw-input .code-header"),
  ).toContainText("json");
  await expect(read.locator(".tool-output-frame .code-header")).toContainText(
    "typescript",
  );
  await expect(read.locator(".tool-output-frame .code-lines")).toContainText("200");
  await expect(read.locator(".tool-output-frame .code-lines")).toContainText("201");
  await expect(read.locator(".tool-output-frame .code-source code")).toContainText(
    "export const answer = 43;",
  );
  // 工具提示语不进代码块，而是代码块外的备注
  await expect(read.locator(".tool-output-frame .code-source code")).not.toContainText(
    "more lines in file",
  );
  await expect(read.locator(".tool-notices")).toContainText(
    "[246 more lines in file. Use offset=202 to continue.]",
  );

  // bash：INPUT 是 bash 代码块（命令），OUTPUT 原样展示终端文本（markdown 不会改写 # / *）
  const bash = card("bash");
  // 三张工具卡（read/bash/grep）都在，并且卡片自带复制按钮（图标、仅 hover 可见）
  expect(await page.locator(".tool-block").count()).toBeGreaterThanOrEqual(3);
  expect(await page.locator(".tool-block .code-copy").count()).toBeGreaterThan(0);
  await expect(bash.locator(".tool-output-frame pre.plain-output")).toHaveText(
    "# not a heading\n* not a bullet",
  );
  await expect(bash.locator(".tool-output-frame h1")).toHaveCount(0);
  await expect(bash.locator(".tool-output-frame ul")).toHaveCount(0);

  // grep：标题取 pattern；INPUT 是可读参数；结果逐行原文（路径里的 _、* 不被 markdown 改写）
  const grep = card("grep");
  await expect(grep.locator(".tool-title")).toContainText("TODO");
  const grepInput = grep.locator(".tool-body > .tool-io-section").first();
  await expect(grepInput.locator(".tool-params dt")).toHaveText([
    "模式",
    "路径",
    "文件过滤",
  ]);
  await expect(grepInput.locator(".tool-params dd").first()).toHaveText("TODO");
  await expect(grep.locator(".tool-output-frame pre.plain-output")).toHaveText(
    "src/a_b.ts:12: // TODO fix *this*\nsrc/c.ts:3: // TODO",
  );
  await expect(grep.locator(".tool-output-frame em")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("edit falls back to argument hunks without line numbers until the result arrives", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    messages: [
      ...fixture().messages,
      { id: "fb-u1", role: "user", content: "改一行" },
      {
        id: "fb-a1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-fallback",
            name: "edit",
            arguments: {
              file_path: "src/fallback.ts",
              oldText: "const before = 1;",
              newText: "const after = 2;",
            },
          },
        ],
      },
      {
        id: "fb-r1",
        role: "toolResult",
        toolCallId: "call-fallback",
        toolName: "edit",
        content: [{ type: "text", text: "已修改 src/fallback.ts" }],
      },
    ],
  });
  await open(page, web);
  const card = page
    .locator(".tool-block")
    .filter({ hasText: /^edit/ })
    .first();
  await expect(card.locator(".diff-removed .diff-text")).toHaveText(
    "const before = 1;",
  );
  await expect(card.locator(".diff-added .diff-text")).toHaveText(
    "const after = 2;",
  );
  // 参数里没有文件行号，行号列留空
  await expect(card.locator(".diff-removed .diff-number")).toHaveText("");
});

// 两个扩展请求：一个 ask_user_question（package 定制外观）、一个通用请求
const activityRequests = () => [
  {
    id: "act-generic",
    sessionId: "session-browser",
    kind: "select",
    title: "通用请求",
    text: "请选择一项",
    options: ["甲", "乙"],
  },
  {
    id: "act-ask",
    sessionId: "session-browser",
    packageId: "@juicesharp/rpiv-ask-user-question",
    kind: "ask_user_question",
    toolCallId: "tc-1",
    title: "很长的工具标题",
    questions: [
      {
        header: "选择",
        question: "选哪个？",
        multiSelect: true,
        options: [
          { label: "A", description: "甲" },
          { label: "B", description: "乙" },
        ],
      },
    ],
  },
];

test("activity bar shows one tab per extension request with package look", async ({
  page,
  web,
}) => {
  web.setSnapshot({ requests: activityRequests() });
  const errors = await open(page, web);
  const tabs = page.locator(".activity-tab");
  await expect(tabs).toHaveCount(2);

  // 同优先级（1000）按到达顺序：先来的通用请求在左
  await expect(tabs.nth(0).locator(".activity-tab-label")).toHaveText("通用请求");
  // ask_user_question 用 package 定制名（不是那个很长的工具标题）
  await expect(tabs.nth(1).locator(".activity-tab-label")).toHaveText("提问");
  await expect(tabs.nth(1).locator(".activity-tab-icon svg")).toHaveCount(1);

  // 各自 tone 不同：通用=紫，提问=黄
  const borderColors = await page
    .locator(".activity-tab")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).borderLeftColor),
    );
  expect(new Set(borderColors).size).toBe(2);

  // 大框内容按 tab 切换，且都保持挂载（切换不重建）
  await expect(page.locator(".activity-panel:visible")).toHaveCount(1);
  // `.role` 用 text-transform:uppercase，innerText 取到的是原样大小写
  await expect(
    page.locator(".activity-panel:visible .plugin-request-head .role"),
  ).toContainText("select");
  await page.locator('.activity-panel:visible [data-activity-tab="act-ask"]').click();
  await expect(page.locator(".ask-user-form")).toBeVisible();
  expect(errors).toEqual([]);
});

test("prompt queue activity stacks guidance above queued messages and deletes one item", async ({
  page,
  web,
}) => {
  const queue = {
    revision: 1,
    count: 1,
    steering: [],
    followUp: [
      { id: "followUp:0:one", kind: "followUp", index: 0, text: "已有后续任务" },
    ],
  };
  web.setSnapshot({ busy: true, pending: true, promptQueue: queue });
  web.setActionHandler(async (action, server) => {
    if (action.type === "queue_add") {
      const items = action.kind === "steer" ? queue.steering : queue.followUp;
      items.push({
        id: `${action.kind}:${items.length}:new`,
        kind: action.kind,
        index: items.length,
        text: action.text,
      });
      queue.revision += 1;
      queue.count += 1;
      server.publish({ promptQueue: structuredClone(queue) });
      return { promptQueue: queue };
    }
    if (action.type === "queue_remove") {
      const removed = [...queue.steering, ...queue.followUp].find(
        (item) => item.id === action.id,
      );
      queue.steering = queue.steering.filter((item) => item.id !== action.id);
      queue.followUp = queue.followUp.filter((item) => item.id !== action.id);
      queue.followUp.forEach((item, index) => (item.index = index));
      queue.revision += 1;
      queue.count -= 1;
      server.publish({ promptQueue: structuredClone(queue) });
      return { removed, queue };
    }
    return {};
  });
  await page.goto(new URL(`/#${token}`, web.server.url).toString());
  const tab = page.locator('[data-activity-tab="prompt-queue"]');
  await expect(tab).toContainText("队列 1");
  await tab.click();
  const panel = page.locator(".prompt-queue-panel");
  await expect(panel).toContainText("已有后续任务");
  await expect(panel.locator(".prompt-queue-compose")).toHaveCount(0);
  await expect(panel.locator(".prompt-queue-group")).toHaveCount(1);
  await expect(panel.locator(".prompt-queue-group")).toHaveText(
    /排队后续轮.*Follow-up 会在当前轮结束后执行.*已有后续任务/s,
  );
  await expect(panel.locator(".prompt-queue-group-head")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  const layout = await panel.locator(".prompt-queue-lists").evaluate((node) => ({
    display: getComputedStyle(node).display,
    columns: getComputedStyle(node).gridTemplateColumns,
  }));
  expect(layout.display).toBe("grid");
  expect(layout.columns.split(" ")).toHaveLength(1);
  await panel.getByRole("button", { name: "删除排队消息：已有后续任务" }).click();
  await expect(page.locator('[data-activity-tab="prompt-queue"]')).toHaveCount(0);
  expect(web.actions.filter((action) => action.type === "queue_remove")[0]).toMatchObject({
    id: "followUp:0:one",
    revision: 1,
  });
});

test("prompt queue activity stays hidden while the model is busy with an empty queue", async ({
  page,
  web,
}) => {
  web.setSnapshot({
    busy: true,
    pending: false,
    promptQueue: { revision: 0, count: 0, steering: [], followUp: [] },
  });
  await page.goto(new URL(`/#${token}`, web.server.url).toString());
  await expect(page.locator('[data-activity-tab="prompt-queue"]')).toHaveCount(0);
});

test("prompt queue activity edits queued text and moves it into steering", async ({
  page,
  web,
}) => {
  const queue = {
    revision: 4,
    count: 1,
    steering: [],
    followUp: [
      { id: "followUp:0:draft", kind: "followUp", index: 0, text: "原排队内容" },
    ],
  };
  web.setSnapshot({ busy: true, pending: true, promptQueue: queue });
  web.setActionHandler(async (action, server) => {
    if (action.type !== "queue_update_item") return {};
    const previous = queue.followUp[0];
    queue.followUp = [];
    queue.steering = [
      { id: "steer:0:updated", kind: "steer", index: 0, text: action.text },
    ];
    queue.revision += 1;
    server.publish({ promptQueue: structuredClone(queue) });
    return { previous, updated: queue.steering[0], queue };
  });
  await page.goto(new URL(`/#${token}`, web.server.url).toString());
  await page.locator('[data-activity-tab="prompt-queue"]').click();
  const panel = page.locator(".prompt-queue-panel");

  await panel.getByRole("button", { name: "编辑排队消息：原排队内容" }).click();
  const editor = panel.locator('textarea[aria-label="编辑排队消息"]');
  await editor.fill("修改后的引导内容");
  await panel.getByRole("button", { name: "保存为引导" }).click();

  await expect(panel.getByText("修改后的引导内容", { exact: true })).toBeVisible();
  const action = web.actions.find((item) => item.type === "queue_update_item");
  expect(action).toMatchObject({
    id: "followUp:0:draft",
    revision: 4,
    kind: "steer",
    text: "修改后的引导内容",
  });
});

test("collapsing an activity panel keeps the in-progress form state", async ({
  page,
  web,
}) => {
  web.setSnapshot({ requests: activityRequests() });
  const errors = await open(page, web);
  // 切到提问那个大框并填一半
  await page.locator('.activity-tabs [data-activity-tab="act-ask"]').click();
  await expect(page.locator(".ask-user-form")).toBeVisible();
  await page.locator('[data-ask-option="0"]').check();
  await page.locator("[data-ask-text]").fill("填到一半的答案");

  // 最小化：大框全部隐藏，但**不卸载**
  await page.locator("[data-activity-collapse]").click();
  await expect(page.locator(".activity-panel:visible")).toHaveCount(0);
  await expect(page.locator(".ask-user-form")).toHaveCount(1); // 仍在 DOM 中

  // 再次展开：之前填的内容必须原样保留
  await page.locator('.activity-tabs [data-activity-tab="act-ask"]').click();
  await expect(page.locator('[data-ask-option="0"]')).toBeChecked();
  await expect(page.locator("[data-ask-text]")).toHaveValue("填到一半的答案");
  expect(errors).toEqual([]);
});

test("activity bar keyboard navigation moves focus between requests", async ({
  page,
  web,
}) => {
  web.setSnapshot({ requests: activityRequests() });
  const errors = await open(page, web);
  const focusedTab = () =>
    page.evaluate(() =>
      document.activeElement?.getAttribute("data-activity-tab"),
    );

  // 展开态下方向键移动焦点，并切换到对应的大框
  await page.locator('.activity-panel:visible [data-activity-tab="act-generic"]').press("ArrowRight");
  await expect.poll(focusedTab).toBe("act-ask");
  await expect(page.locator(".ask-user-form")).toBeVisible();
  await page.locator('.activity-panel:visible [data-activity-tab="act-ask"]').press("ArrowLeft");
  await expect.poll(focusedTab).toBe("act-generic");
  expect(errors).toEqual([]);
});

test("the session title is renamed through the command path", async ({
  page,
  web,
}) => {
  await open(page, web);
  await expect(page.locator("#view-title")).toHaveText("浏览器回归会话");
  const sent = () =>
    web.actions
      .filter((action) => action.type === "send")
      .map((action) => action.text);

  await page.locator("#rename-session").click();
  await page.fill("#rename-session-input", "重命名后的会话");
  await page.locator("#rename-session-input").press("Enter");
  await expect.poll(sent).toContain("/name 重命名后的会话");

  // Escape 取消：不发动作，标题不变
  await page.locator("#rename-session").click();
  await page.fill("#rename-session-input", "不会生效");
  await page.locator("#rename-session-input").press("Escape");
  await expect(page.locator("#rename-session-input")).toHaveCount(0);
  await expect(page.locator("#view-title")).toHaveText("浏览器回归会话");
  expect(sent()).toHaveLength(1);
});
