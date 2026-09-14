const MAX_TEXT_LENGTH = 32000;

/**
 * Build the host's public `QuestionnaireResult` from a browser draft.
 * Mirrors `state/state-reducer.ts` semantics:
 * - an unanswered tab contributes no entry at all,
 * - a multi-select answer carries `selected` labels and `answer: null`,
 * - free text is its own `kind: "custom"` answer (never appended to `selected`),
 * - notes/globalNote are attached only when non-blank, matching the host's
 *   conditional-spread contract.
 */
export function buildAskUserResult(questions, draft, cancelled = false, globalNote = "") {
  if (!Array.isArray(draft) || draft.length !== questions.length)
    throw new Error("问卷答案数量不匹配");
  if (typeof globalNote !== "string" || globalNote.length > MAX_TEXT_LENGTH)
    throw new Error("全局备注过长或无效");
  const answers = [];
  questions.forEach((question, questionIndex) => {
    const entry = draft[questionIndex];
    if (!entry || !["unanswered", "option", "multi", "custom"].includes(entry.kind))
      throw new Error("无效答案类型");
    if (entry.notes !== undefined && (typeof entry.notes !== "string" || entry.notes.length > MAX_TEXT_LENGTH))
      throw new Error("备注过长或无效");
    if (entry.kind === "unanswered") return;
    const answer = {
      questionIndex,
      question: question.question,
      kind: entry.kind,
      answer: null,
    };
    if (entry.kind === "option") {
      if (question.multiSelect || !Number.isInteger(entry.option) || !question.options[entry.option])
        throw new Error("无效单选答案");
      const option = question.options[entry.option];
      answer.answer = option.label;
      if (option.preview) answer.preview = option.preview;
    } else if (entry.kind === "multi") {
      if (!question.multiSelect || !Array.isArray(entry.options) ||
          entry.options.some(index => !Number.isInteger(index) || !question.options[index]) ||
          new Set(entry.options).size !== entry.options.length)
        throw new Error("无效多选答案");
      const selected = question.options
        .filter((_, index) => entry.options.includes(index))
        .map(option => option.label);
      // 自由文本是独立存储：用户既勾选又填写时，文本作为一个额外 selected 项
      // 提交（宿主的 multi 答案只有 selected 数组，没有承载自由文本的字段）。
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (entry.text !== undefined && typeof entry.text !== "string")
        throw new Error("自由回答过长或无效");
      if (entry.custom === true && text.length > 0) {
        if (text.length > MAX_TEXT_LENGTH) throw new Error("自由回答过长或无效");
        selected.push(text);
      }
      // 勾选与文本都为空 = 未答（宿主对空选择直接删除该答案）
      if (selected.length === 0) return;
      answer.selected = selected;
    } else {
      if (typeof entry.text !== "string" || entry.text.length > MAX_TEXT_LENGTH)
        throw new Error("自由回答过长或无效");
      answer.answer = entry.text || null;
    }
    const notes = entry.notes?.trim();
    if (notes) answer.notes = notes;
    answers.push(answer);
  });
  const normalizedGlobalNote = globalNote.trim();
  return {
    answers,
    cancelled,
    ...(normalizedGlobalNote ? { globalNote: normalizedGlobalNote } : {}),
  };
}
