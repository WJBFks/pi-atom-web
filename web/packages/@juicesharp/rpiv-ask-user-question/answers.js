// Package-owned questionnaire schema limits, mirroring the host's public
// `tool/types.ts` contract (MAX_QUESTIONS/MAX_OPTIONS/MAX_HEADER_LENGTH/...).
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;
const MAX_TEXT_LENGTH = 32000;

const clipped = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : "";

/**
 * Bounded, render-safe view of `request.questions`. The backend adapter already
 * rejects malformed questionnaires before claiming a request; this keeps a
 * hand-crafted or legacy payload from throwing inside the form.
 */
export function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_QUESTIONS).map((entry) => {
    const question = entry && typeof entry === "object" ? entry : {};
    return {
      question: clipped(question.question, MAX_TEXT_LENGTH),
      header: clipped(question.header, MAX_HEADER_LENGTH),
      multiSelect: question.multiSelect === true,
      options: (Array.isArray(question.options) ? question.options : [])
        .slice(0, MAX_OPTIONS)
        .map((entry) => {
          const option = entry && typeof entry === "object" ? entry : {};
          const preview = clipped(option.preview, MAX_TEXT_LENGTH);
          return {
            label: clipped(option.label, MAX_LABEL_LENGTH),
            description: clipped(option.description, MAX_TEXT_LENGTH),
            ...(preview ? { preview } : {}),
          };
        }),
    };
  });
}

export const blankAnswer = () => ({
  kind: "unanswered",
  option: 0,
  options: [],
  custom: false,
  text: "",
  notes: "",
});

/**
 * “已作答”的唯一判定：单选/自由文本看 kind，多选看**勾选或文本任一非空**
 * （勾选与文本是两个独立存储，取消全部勾选但留着文本仍算已答）。
 * tab 上的 ✓、核对页的未答提示与提交按钮都用它，避免三处规则各写一套。
 */
export function isAnswered(question, answer) {
  if (!answer || answer.kind === "unanswered") return false;
  if (question.multiSelect)
    return answer.options.length > 0 || answer.text.trim().length > 0;
  return true;
}

export function normalizeAnswers(questions, saved) {
  return questions.map((question, index) => {
    const raw = saved?.[index];
    if (!raw || !["unanswered", "option", "multi", "custom"].includes(raw.kind))
      return blankAnswer();
    const answer = {
      ...blankAnswer(),
      kind: raw.kind,
      option:
        Number.isInteger(raw.option) && question.options[raw.option]
          ? raw.option
          : 0,
      options: [
        ...new Set(
          (Array.isArray(raw.options) ? raw.options : []).filter(
            (i) => Number.isInteger(i) && question.options[i],
          ),
        ),
      ],
      custom: raw.custom === true || raw.kind === "custom",
      text: typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT_LENGTH) : "",
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, MAX_TEXT_LENGTH) : "",
    };
    if (!question.multiSelect) {
      if (answer.kind === "multi") return blankAnswer();
      if (answer.kind === "option" && answer.custom) return blankAnswer();
      return answer;
    }
    // 多选：勾选（`options`）与自由文本（`text`）是两个独立存储，可共存；
    // 无勾选也无文本才算未答。
    // 注意：**不能**因为 kind 是 `custom` 就丢掉 `options`（草稿恢复、切 tab、
    // 刷新都会走到这里，清了就等于用户勾选项莫名消失）。
    const hasOptions = answer.options.length > 0;
    // 纯空白不算内容（与备注/全局备注的空白处理一致）
    const hasText = answer.text.trim().length > 0;
    // 自由文本行的勾选态（`custom`）是独立存储，原样保留：**不能**由 text 反推，
    // 勾上但尚未输入时 text 为空，也必须仍然是「已勾选」。
    if (!hasOptions && !hasText)
      return { ...blankAnswer(), custom: answer.custom };
    // 多选题的 kind 恒为 `multi`；自由文本由 `text` 携带，提交时并入 selected。
    answer.kind = "multi";
    return answer;
  });
}

export function serializeAnswers(answers) {
  return JSON.parse(JSON.stringify(answers));
}

export function answerText(question, answer) {
  if (answer.kind === "unanswered") return "未回答";
  if (answer.kind === "custom") return answer.text || "空白自由回答";
  if (answer.kind === "multi") {
    const labels = answer.options
      .map((i) => question.options[i]?.label)
      .filter(Boolean);
    // 自由文本与勾选项可共存，预览里一并展示
    if (answer.custom && answer.text) labels.push(answer.text);
    return labels.join("、") || "未选择任何选项";
  }
  return question.options[answer.option]?.label || "未回答";
}
