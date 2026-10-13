/**
 * `ask_user_question` 的工具档案（package 专属，用户 2026-09-26）。
 *
 * - `label: "提问"`：会话转录里卡片标题显示「提问」，不是工具原名；
 *   活动组件栏那边的 tab 标题走另一条路（package 载荷里的定制名优先，见 `stores/dialogs.js`）。
 * - `solo: true`：工具卡**不折进中间过程组**，单独平铺在组之间；它的工具结果条一并平铺
 *   （结果条已被卡片按 `toolCallId` 合并、渲染成 `null`，留在组里会开出一个空组）。
 *   **计数不变**：轮次标题仍把它算进「工具调用`n`」，只有中间过程组的标题不含它。
 * - `summary(args)`：折叠态摘要显示**第一题的 `header`**（用户 2026-09-26 定口径：
 *   只显示第一题 + 题数；缺 `header` 退回题干；**答完也照旧显示 `header`**，不换成答案）。
 * - `icon`：卡片左侧的**专属图标**（用户 2026-09-26：“单独为提问准备一个图标”）。
 *   定义在同目录 `icon.js` 里（纯数据），由通用图标基座登记与渲染。
 *
 * 通用侧的查表逻辑在 `web/packages/tool-profiles.js`。
 */
import { sanitizeQuestions } from "./answers.js";
import { ASK_ICON_MARKUP, ASK_ICON_NAME } from "./icon.js";

// 缺 header 时退回题干的截断长度：与 header 上限（`MAX_HEADER_LENGTH` = 16）同档，
// 免得缺 header 的那格比别的题的 header 长出一截。
const FALLBACK_TEXT_LENGTH = 16;

const firstLabel = (questions) => {
  const first = questions[0];
  if (!first) return "";
  const header = String(first.header || "").trim();
  if (header) return header;
  const question = String(first.question || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!question) return "";
  return question.length > FALLBACK_TEXT_LENGTH
    ? `${question.slice(0, FALLBACK_TEXT_LENGTH)}…`
    : question;
};

export default {
  tool: "ask_user_question",
  label: "提问",
  solo: true,
  icon: { name: ASK_ICON_NAME, markup: ASK_ICON_MARKUP },
  /**
   * 摘要走 `sanitizeQuestions()`，与表单渲染用的是同一份裁剪（题数上限、header 上限、
   * 空白压平），所以「等 N 题」里的 N 与用户实际看到的 tab 数一致。
   * 返回空串（没有题、或第一题既无 header 又无题干）时通用侧退回默认摘要。
   */
  summary(args) {
    const questions = sanitizeQuestions(args?.questions);
    const head = firstLabel(questions);
    if (!head) return "";
    return questions.length > 1 ? `${head} 等 ${questions.length} 题` : head;
  },
};
