import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import {
  normalizeAnswers,
  answerText,
  serializeAnswers,
} from "../web/packages/@juicesharp/rpiv-ask-user-question/answers.js";
const questions = [
  {
    header: "多选",
    multiSelect: true,
    options: [{ label: "A" }, { label: "B" }],
  },
];
test("questionnaire drafts recover safely and serialize Vue proxies as plain answers", () => {
  const answers = reactive(
    normalizeAnswers(questions, [
      { kind: "multi", options: [0, 99, 0], custom: true, text: "其他" },
    ]),
  );
  assert.deepEqual(answers[0].options, [0]);
  assert.equal(answerText(questions[0], answers[0]), "A、其他");
  const result = serializeAnswers(answers);
  assert.doesNotThrow(() => structuredClone(result));
  assert.equal(result[0].custom, true);
  assert.deepEqual(normalizeAnswers(questions, [null])[0].options, []);
});
