export const blankAnswer = () => ({
  kind: "unanswered",
  option: 0,
  options: [],
  custom: false,
  text: "",
  notes: "",
});
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
      custom: raw.custom === true,
      text: typeof raw.text === "string" ? raw.text.slice(0, 32000) : "",
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, 32000) : "",
    };
    if (question.multiSelect && answer.kind === "custom") {
      answer.kind = "multi";
      answer.custom = true;
    }
    if (question.multiSelect && answer.kind === "option") return blankAnswer();
    if (!question.multiSelect && answer.kind === "multi") return blankAnswer();
    return answer;
  });
}
export function serializeAnswers(answers) {
  return JSON.parse(JSON.stringify(answers));
}
export function answerText(question, answer) {
  if (answer.kind === "unanswered") return "未回答";
  if (answer.kind === "custom") return answer.text || "空白自由回答";
  if (answer.kind === "multi")
    return (
      [
        ...answer.options
          .map((i) => question.options[i]?.label)
          .filter(Boolean),
        ...(answer.custom && answer.text ? [answer.text] : []),
      ].join("、") || "未选择任何选项"
    );
  return question.options[answer.option]?.label || "未回答";
}
