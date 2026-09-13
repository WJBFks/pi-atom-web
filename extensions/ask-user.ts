/** Dedicated adapter for @juicesharp/rpiv-ask-user-question's public prompt event
 * and QuestionnaireResult contract. Never derive questions from rendered text. */
export function createAskUserAdapter() {
  const calls = new Map();
  const ready = [];
  const summary = questions => JSON.stringify(questions.map(q => ({question:q.question,header:q.header,multiSelect:q.multiSelect ?? false,options:q.options.map(o=>({label:o.label,description:o.description,hasPreview:typeof o.preview === 'string' && o.preview.length > 0}))})));
  return {
    start(event) {
      if (event.toolName !== 'ask_user_question' || !Array.isArray(event.args?.questions)) return;
      calls.set(event.toolCallId, structuredClone(event.args.questions));
    },
    prompt(payload) {
      if (!Array.isArray(payload?.questions)) return;
      const normalized = payload.questions.map(q=>({question:q.question,header:q.header,multiSelect:q.multiSelect ?? false,options:(q.options || []).map(o=>({label:o.label,description:o.description,hasPreview:!!o.hasPreview}))}));
      const matching = [...calls].filter(([,questions]) => summary(questions) === JSON.stringify(normalized));
      if (matching.length !== 1) return; // Ambiguous calls must never share answers.
      const [toolCallId, questions] = matching[0];
      if (!ready.some(item=>item.toolCallId===toolCallId)) ready.push({toolCallId,questions});
    },
    take(factory) {
      // Version-specific guard: only the inspected questionnaire factory is eligible.
      // Another extension's concurrent custom() request must remain untouched.
      if (!Function.prototype.toString.call(factory).includes('QuestionnaireSession') || ready.length !== 1) return;
      return ready.shift();
    },
    end(id) { calls.delete(id); const i=ready.findIndex(r=>r.toolCallId===id);if(i>=0)ready.splice(i,1); },
    clear() {calls.clear();ready.length=0;},
  };
}

export function buildAskUserResult(questions, draft, cancelled = false) {
  if (!Array.isArray(draft) || draft.length !== questions.length) throw new Error('问卷答案数量不匹配');
  const answers = [];
  questions.forEach((q,i) => {
    const entry = draft[i];
    if (!entry || !['unanswered','option','multi','custom'].includes(entry.kind)) throw new Error('无效答案类型');
    if (entry.notes !== undefined && (typeof entry.notes !== 'string' || entry.notes.length > 32000)) throw new Error('备注过长或无效');
    if (entry.kind === 'unanswered') return;
    const answer = {questionIndex:i,question:q.question,kind:entry.kind,answer:null};
    if (entry.kind === 'option') {
      if (q.multiSelect || !Number.isInteger(entry.option) || !q.options[entry.option]) throw new Error('无效单选答案');
      const option = q.options[entry.option];
      answer.answer = option.label;
      if (option.preview) answer.preview = option.preview;
    } else if (entry.kind === 'multi') {
      if (!q.multiSelect || !Array.isArray(entry.options) || entry.options.some(n=>!Number.isInteger(n)||!q.options[n]) || new Set(entry.options).size!==entry.options.length) throw new Error('无效多选答案');
      answer.selected = q.options.filter((_,index)=>entry.options.includes(index)).map(o=>o.label);
      if (entry.custom !== undefined && typeof entry.custom !== 'boolean') throw new Error('无效多选自由回答状态');
      const customText = entry.text ?? '';
      if (typeof customText !== 'string' || customText.length > 32000) throw new Error('自由回答过长或无效');
      if (entry.custom && customText) answer.selected.push(customText);
    } else {
      if (typeof entry.text !== 'string' || entry.text.length > 32000) throw new Error('自由回答过长或无效');
      answer.answer = entry.text || null;
    }
    if (entry.notes) answer.notes = entry.notes;
    answers.push(answer);
  });
  return {answers,cancelled};
}
