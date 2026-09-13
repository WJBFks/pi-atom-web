export function buildAskUserResult(questions, draft, cancelled = false, globalNote = "") {
  if (!Array.isArray(draft) || draft.length !== questions.length)
    throw new Error("问卷答案数量不匹配");
  if (typeof globalNote !== "string" || globalNote.length > 32000)
    throw new Error("全局备注过长或无效");
  const answers = [];
  questions.forEach((question, questionIndex) => {
    const entry = draft[questionIndex];
    if (!entry || !["unanswered", "option", "multi", "custom"].includes(entry.kind))
      throw new Error("无效答案类型");
    if (entry.notes !== undefined && (typeof entry.notes !== "string" || entry.notes.length > 32000))
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
      answer.selected = question.options
        .filter((_, index) => entry.options.includes(index))
        .map(option => option.label);
      if (entry.custom !== undefined && typeof entry.custom !== "boolean")
        throw new Error("无效多选自由回答状态");
      const text = entry.text ?? "";
      if (typeof text !== "string" || text.length > 32000)
        throw new Error("自由回答过长或无效");
      if (entry.custom && text) answer.selected.push(text);
    } else {
      if (typeof entry.text !== "string" || entry.text.length > 32000)
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
