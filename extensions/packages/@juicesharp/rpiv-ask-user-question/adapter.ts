const PACKAGE_ID = "@juicesharp/rpiv-ask-user-question";

// Package-owned copy of the host's public questionnaire schema limits
// (`tool/types.ts`). The adapter validates the tool call before it claims a
// custom UI: a malformed call must fall back to the generic terminal instead of
// feeding an unsupported payload to the browser.
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;
const MAX_TEXT_LENGTH = 32000;

const boundedText = (value, max) =>
  typeof value === "string" && value.length <= max;

const isOption = option =>
  Boolean(option) &&
  typeof option === "object" &&
  boundedText(option.label, MAX_LABEL_LENGTH) &&
  option.label.length > 0 &&
  boundedText(option.description ?? "", MAX_TEXT_LENGTH) &&
  (option.preview === undefined || boundedText(option.preview, MAX_TEXT_LENGTH));

const isQuestion = question =>
  Boolean(question) &&
  typeof question === "object" &&
  boundedText(question.question, MAX_TEXT_LENGTH) &&
  boundedText(question.header, MAX_HEADER_LENGTH) &&
  (question.multiSelect === undefined || typeof question.multiSelect === "boolean") &&
  Array.isArray(question.options) &&
  question.options.length >= MIN_OPTIONS &&
  question.options.length <= MAX_OPTIONS &&
  question.options.every(isOption);

const validQuestions = questions =>
  Array.isArray(questions) &&
  questions.length >= 1 &&
  questions.length <= MAX_QUESTIONS &&
  questions.every(isQuestion);

const isQuestionnaireFactory = factory => {
  if (typeof factory !== "function") return false;
  const source = Function.prototype.toString.call(factory);
  if (source.includes("QuestionnaireSession")) return true;
  return factory.length === 4
    && /\bnew\s+Session\s*\(/.test(source)
    && /sessionRef\.current\s*=\s*session\b/.test(source)
    && /return\s+session\.component/.test(source);
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
      if (event.toolName !== "ask_user_question" || !validQuestions(event.args?.questions)) return;
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
      if (!isQuestionnaireFactory(factory)) return undefined;
      // 只保留仍然对应一个未结束工具调用的候选，避免上一轮残留把
      // `ready.length !== 1` 永久挡死（之前的版本会静默回退到通用终端）。
      for (let index = ready.length - 1; index >= 0; index--)
        if (!calls.has(ready[index].toolCallId)) ready.splice(index, 1);
      if (ready.length !== 1) return undefined;
      const selected = ready.shift();
      if (!validQuestions(selected.questions)) return undefined;
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
