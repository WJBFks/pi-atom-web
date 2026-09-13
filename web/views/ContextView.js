import { computed, defineComponent, h } from "vue";
import { useSessionStore } from "../stores/session.js";
import { useConversationStore } from "../stores/conversation.js";
import DetailRows from "../components/status/DetailRows.js";
import MarkdownContent from "../components/conversation/MarkdownContent.js";

// 上下文页：把「这一轮对话现在由什么构成」摊开——模型、用量、以及分支摘要/上下文压缩
// 产生的摘要条目。数据全部来自快照，不额外请求模型。
export function contextSummaries(messages = []) {
  return messages
    .filter(
      (message) =>
        message.role === "branchSummary" ||
        message.role === "compactionSummary",
    )
    .map((message) => ({
      id: String(message.id ?? `${message.role}:${message.summary || ""}`),
      label: message.role === "branchSummary" ? "分支摘要" : "上下文摘要",
      text: message.summary || "",
    }));
}

export default defineComponent({
  name: "ContextView",
  props: { onError: Function },
  setup() {
    const session = useSessionStore(),
      conversation = useConversationStore();
    const summaries = computed(() => contextSummaries(conversation.messages));
    const rows = computed(() => {
      const stats = session.stats || {};
      return [
        { label: "模型", value: session.model || "—" },
        { label: "思考等级", value: session.thinking || "—" },
        { label: "对话轮数", value: String(stats.rounds ?? 0) },
        { label: "轨迹事件数", value: String(stats.events ?? 0) },
        { label: "上下文摘要条数", value: String(summaries.value.length) },
      ];
    });
    const section = (title, children, hint) =>
      h("section", { class: "page-section" }, [
        h("h3", title),
        hint ? h("p", { class: "page-hint" }, hint) : null,
        ...children,
      ]);
    return () =>
      h("div", { class: "page" }, [
        section("上下文构成", [
          h(
            "div",
            { class: "detail-rows" },
            rows.value.map((row) =>
              h("div", { class: "status-detail", key: row.label }, [
                h("span", row.label),
                h("strong", row.value),
              ]),
            ),
          ),
        ]),
        section(
          "Token 用量",
          [h("div", { class: "detail-rows" }, [h(DetailRows, { session, kind: "tokens" })])],
          "按当前分支累计，缓存读写单独统计。",
        ),
        section(
          "缓存与成本",
          [h("div", { class: "detail-rows" }, [h(DetailRows, { session, kind: "cache" })])],
        ),
        section(
          "分支与上下文摘要",
          summaries.value.length
            ? summaries.value.map((item) =>
                h("article", { class: "summary-card", key: item.id }, [
                  h("span", { class: "summary-tag" }, item.label),
                  h(MarkdownContent, { text: item.text }),
                ]),
              )
            : [
                h(
                  "p",
                  { class: "page-hint" },
                  "这段会话还没有分支摘要或上下文压缩记录。",
                ),
              ],
          "执行 /compact 或切换分支后出现的摘要会列在这里。",
        ),
      ]);
  },
});
