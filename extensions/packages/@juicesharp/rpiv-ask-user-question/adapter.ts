const PACKAGE_ID = "@juicesharp/rpiv-ask-user-question";

const isQuestionnaireFactory = factory => {
  if (typeof factory !== "function") return false;
  const source = Function.prototype.toString.call(factory);
  if (source.includes("QuestionnaireSession")) return true;
  return factory.length === 4
    && /\bnew\s+Session\s*\(/.test(source)
    && /sessionRef\.current\s*=\s*session\b/.test(source)
    && /return\s+session\.component\b/.test(source);
};

const eventQuestions = questions =>
  questions.map(question => ({
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect ?? false,
    options: (question.options || []).map(option => ({
      label: option.label,
      description: option.description,
      hasPreview: Boolean(option.hasPreview),
    })),
  }));

const callQuestions = questions =>
  questions.map(question => ({
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect ?? false,
    options: (question.options || []).map(option => ({
      label: option.label,
      description: option.description,
      hasPreview: typeof option.preview === "string" && option.preview.length > 0,
    })),
  }));

export function createAskUserAdapter(buildResult) {
  const calls = new Map();
  const ready = [];
  return {
    start(event) {
      if (event.toolName !== "ask_user_question" || !Array.isArray(event.args?.questions)) return;
      calls.set(String(event.toolCallId), structuredClone(event.args.questions));
    },
    prompt(payload) {
      if (!Array.isArray(payload?.questions)) return;
      const signature = JSON.stringify(eventQuestions(payload.questions));
      const matching = [...calls].filter(([, questions]) =>
        JSON.stringify(callQuestions(questions)) === signature);
      if (matching.length !== 1) return;
      const [toolCallId, questions] = matching[0];
      if (!ready.some(item => item.toolCallId === toolCallId))
        ready.push({ toolCallId, questions });
    },
    take(factory) {
      if (!isQuestionnaireFactory(factory) || ready.length !== 1)
        return undefined;
      const selected = ready.shift();
      return {
        packageId: PACKAGE_ID,
        toolCallId: selected.toolCallId,
        questions: selected.questions,
        request: {
          kind: "ask_user_question",
          toolCallId: selected.toolCallId,
          questions: selected.questions,
        },
        buildResult: (value, cancel) =>
          buildResult(
            selected.questions,
            value?.draft ??
              (cancel
                ? selected.questions.map(() => ({ kind: "unanswered" }))
                : undefined),
            cancel,
            value?.globalNote ?? "",
          ),
      };
    },
    end(toolCallId) {
      const id = String(toolCallId);
      calls.delete(id);
      const index = ready.findIndex(item => item.toolCallId === id);
      if (index >= 0) ready.splice(index, 1);
    },
    clear() {
      calls.clear();
      ready.length = 0;
    },
  };
}
