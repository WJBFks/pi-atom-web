import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import {
  normalizeAnswers,
  answerText,
  answerItems,
  serializeAnswers,
  sanitizeQuestions,
} from "../web/packages/@juicesharp/rpiv-ask-user-question/answers.js";
import { buildAskUserResult } from "../extensions/packages/@juicesharp/rpiv-ask-user-question/index.ts";
const questions = [
  {
    header: "多选",
    multiSelect: true,
    options: [{ label: "A" }, { label: "B" }],
  },
];
test("questionnaire drafts recover safely and serialize Vue proxies as plain answers", () => {
  const answers = reactive(
    normalizeAnswers(questions, [{ kind: "multi", options: [0, 99, 0] }]),
  );
  assert.deepEqual(answers[0].options, [0]);
  assert.equal(answers[0].kind, "multi");
  assert.equal(answerText(questions[0], answers[0]), "A");
  const result = serializeAnswers(answers);
  assert.doesNotThrow(() => structuredClone(result));
  assert.deepEqual(normalizeAnswers(questions, [null])[0].options, []);
});

test("multi answers follow host semantics: cleared checkboxes mean unanswered", () => {
  const cleared = normalizeAnswers(questions, [{ kind: "multi", options: [] }])[0];
  assert.equal(cleared.kind, "unanswered");
  assert.equal(answerText(questions[0], cleared), "未回答");

  // 单选不接受多选形状，多选不接受单选形状
  const single = [{ header: "单选", options: [{ label: "A" }, { label: "B" }] }];
  assert.equal(
    normalizeAnswers(single, [{ kind: "multi", options: [0] }])[0].kind,
    "unanswered",
  );
  assert.equal(
    normalizeAnswers(questions, [{ kind: "option", option: 0 }])[0].kind,
    "unanswered",
  );
});

test("multi keeps checkboxes and free text as independent stores", () => {
  // 勾选与自由文本互不影响：两者可共存，无勾选且无文本才算未答。
  const both = normalizeAnswers(questions, [
    { kind: "multi", options: [0], custom: true, text: "其他" },
  ])[0];
  assert.equal(both.kind, "multi");
  assert.deepEqual(both.options, [0]);
  assert.equal(both.custom, true);
  assert.equal(both.text, "其他");
  assert.equal(answerText(questions[0], both), "A、其他");

  const textOnly = normalizeAnswers(questions, [
    { kind: "custom", text: "其他" },
  ])[0];
  // 旧草稿的 kind:"custom" 迁移为「自由文本已勾选」；多选题的 kind 恒为 multi
  assert.equal(textOnly.kind, "multi");
  assert.equal(textOnly.custom, true);
  assert.deepEqual(textOnly.options, []);
  assert.equal(answerText(questions[0], textOnly), "其他");

  const empty = normalizeAnswers(questions, [
    { kind: "multi", options: [], custom: true, text: "   " },
  ])[0];
  assert.equal(empty.kind, "unanswered");
});

test("questionnaire requests are sanitized into a render-safe, bounded shape", () => {
  assert.deepEqual(sanitizeQuestions(null), []);
  assert.deepEqual(sanitizeQuestions("nope"), []);
  const [question] = sanitizeQuestions([
    {
      header: "x".repeat(40),
      question: "q",
      multiSelect: "yes",
      options: [{ label: "L".repeat(80), description: "d", preview: "p" }, "junk"],
    },
  ]);
  assert.equal(question.header.length, 16);
  assert.equal(question.multiSelect, false);
  assert.equal(question.options.length, 2);
  assert.equal(question.options[0].label.length, 60);
  assert.equal(question.options[0].preview, "p");
  assert.equal(question.options[1].label, "");
  assert.equal(
    sanitizeQuestions(Array.from({ length: 9 }, () => ({}))).length,
    4,
  );
});

test("multi checkbox, free text and their checked states survive each other's edits", () => {
  const q = [
    {
      header: "多选",
      multiSelect: true,
      question: "要点哪些？",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    },
  ];
  // bug1：先勾选 A 再输入文本 —— A 不能被清掉
  const both = normalizeAnswers(q, [
    { kind: "multi", options: [0], custom: true, text: "自定义" },
  ])[0];
  assert.deepEqual(both.options, [0]);
  assert.equal(both.text, "自定义");
  assert.equal(both.custom, true);
  assert.equal(answerText(q[0], both), "A、自定义");

  // bug2：取消自由文本的勾选 —— 文本保留、只是不参与提交
  const unchecked = normalizeAnswers(q, [
    { kind: "multi", options: [], custom: false, text: "自定义" },
  ])[0];
  assert.equal(unchecked.text, "自定义");
  assert.equal(unchecked.custom, false);
  assert.equal(unchecked.kind, "multi");
  assert.deepEqual(
    buildAskUserResult(q, [unchecked]).answers,
    [],
    "未勾选自由文本行时，文本不参与提交",
  );

  // bug4：只勾上自由文本行、还未输入时 —— 勾选态必须保留
  const checkedEmpty = normalizeAnswers(q, [
    { kind: "multi", options: [], custom: true, text: "" },
  ])[0];
  assert.equal(checkedEmpty.custom, true, "未输入内容时勾选态不能被取消");

  // bug5：只勾选项 + 勾上自由文本行（空）—— 两者都保留
  const optionPlusEmpty = normalizeAnswers(q, [
    { kind: "multi", options: [1], custom: true, text: "" },
  ])[0];
  assert.deepEqual(optionPlusEmpty.options, [1]);
  assert.equal(optionPlusEmpty.custom, true);
  assert.equal(optionPlusEmpty.kind, "multi");

  // bug3：文本勾选后点选项 —— 文本勾选态与内容都保留
  const reordered = normalizeAnswers(q, [
    { kind: "multi", options: [0], custom: true, text: "自定义" },
  ])[0];
  assert.equal(reordered.custom, true);
  assert.equal(reordered.text, "自定义");
  assert.deepEqual(reordered.options, [0]);
});

test("review page numbers selected options and marks custom input with X", () => {
  const single = [{ header: "单选", options: [{ label: "A" }, { label: "B" }] }];
  const multi = [
    { header: "多选", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
  ];
  // 单选：1. 选项
  assert.deepEqual(
    answerItems(single[0], normalizeAnswers(single, [{ kind: "option", option: 1 }])[0]),
    [{ mark: "1", text: "B" }],
  );
  // 单选 + 自定义：X. 文本
  assert.deepEqual(
    answerItems(single[0], normalizeAnswers(single, [{ kind: "custom", text: "自定义回答" }])[0]),
    [{ mark: "X", text: "自定义回答" }],
  );
  // 多选：按勾选顺序编号，自定义输入排在后面用 X.
  assert.deepEqual(
    answerItems(
      multi[0],
      normalizeAnswers(multi, [{ kind: "multi", options: [2, 0], custom: true, text: "其他内容" }])[0],
    ),
    [
      { mark: "1", text: "C" },
      { mark: "2", text: "A" },
      { mark: "X", text: "其他内容" },
    ],
  );
  // 未回答：空列表
  assert.deepEqual(answerItems(multi[0], normalizeAnswers(multi, [null])[0]), []);
  // 勾上自由文本行但还没输入：不出 X. 行
  assert.deepEqual(
    answerItems(multi[0], normalizeAnswers(multi, [{ kind: "multi", options: [], custom: true, text: "" }])[0]),
    [],
  );
});
