import { buildAskUserResult } from './ask-user.ts';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

/** Share plugin dialogs between the existing TUI and authenticated browser. */
export function bridgeDialogs(ui, sessionId, changed, adapters = {}) {
  const pending = new Map();
  const installed = [];
  for (const kind of ['select', 'confirm', 'input']) {
    const original = ui[kind];
    if (typeof original !== 'function') continue;
    const wrapper = async function(title, body, opts = {}) {
      const id = randomUUID();
      const controller = new AbortController();
      let resolveWeb;
      const web = new Promise(resolve => { resolveWeb = resolve; });
      const request = { id, kind, sessionId: sessionId(), title: stripVTControlCharacters(title),
        ...(kind === 'select' ? { options: body.map(stripVTControlCharacters) } : { text: stripVTControlCharacters(body || '') }) };
      const cancelValue = kind === 'confirm' ? false : undefined;
      const settle = value => { resolveWeb(value); controller.abort(); };
      pending.set(id, { request, settle, body, cancelValue });
      changed();
      try {
        const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
        return await Promise.race([web, Promise.resolve(original.call(this, title, body, { ...opts, signal }))]);
      } finally { pending.delete(id); changed(); }
    };
    ui[kind] = wrapper;
    installed.push({ kind, original, wrapper });
  }
  if (typeof ui.custom === 'function') {
    const original = ui.custom;
    const wrapper = async function(factory, opts) {
      const id = randomUUID();
      const askUser = adapters.takeAskUser?.(factory);
      const request = { id, ...(askUser ? {questions:askUser.questions,toolCallId:askUser.toolCallId} : {}), kind:askUser ? 'ask_user_question' : 'custom', sessionId:sessionId(), title:'自定义扩展界面', lines:[] };
      const item = { request, cancelValue:undefined, settle:() => {}, input:undefined };
      let closed = false, finish;
      item.settle = (value) => { closed = true; item.result = value ?? (askUser ? {answers:[],cancelled:true} : undefined); finish?.(item.result); };
      pending.set(id, item); changed();
      try {
        return await original.call(this, async (tui, theme, keys, done) => {
          finish = done;
          const component = await factory(tui, theme, keys, done);
          if (closed) { done(item.result); return component; }
          const render = component.render;
          component.render = function(width) {
            const lines = render.call(this, width);
            if (askUser) return lines;
            const text = lines;
            if (pending.has(id) && JSON.stringify(text) !== JSON.stringify(request.lines)) {
              request.lines = text; request.columns = width; changed();
            }
            return lines;
          };
          item.input = data => { component.handleInput?.(data); tui.requestRender(); };
          return component;
        }, opts);
      } finally { pending.delete(id); changed(); }
    };
    ui.custom = wrapper; installed.push({ kind:'custom', original, wrapper });
  }
  // The TUI editor API has no abort/response hook. Surface it without pretending
  // a browser response can close the terminal editor.
  if (typeof ui.editor === 'function') {
    const original = ui.editor;
    const wrapper = async function(title, prefill) {
      const id = randomUUID();
      pending.set(id, {request:{id, kind:'editor', sessionId:sessionId(), title, text:prefill || '', terminalOnly:true}, settle:()=>{}});
      changed();
      try { return await original.call(this, title, prefill); }
      finally { pending.delete(id); changed(); }
    };
    ui.editor = wrapper; installed.push({kind:'editor', original, wrapper});
  }
  return {
    list: () => [...pending.values()].map(p => p.request).filter(r => r.sessionId === sessionId()),
    respond(id, value, cancel) {
      const item = pending.get(id);
      if (!item || item.request.sessionId !== sessionId()) throw new Error('插件请求已结束或会话已切换');
      if (item.request.kind === 'ask_user_question') {
        const result = buildAskUserResult(item.request.questions, value?.draft ?? (cancel ? item.request.questions.map(()=>({kind:'unanswered'})) : undefined), cancel);
        item.settle(result); pending.delete(id); changed(); return;
      }
      if (item.request.terminalOnly) throw new Error('此编辑请求需在 TUI 中完成');
      if (item.request.kind === 'custom' && !cancel) {
        if (typeof value !== 'string' || value.length > 4096) throw new Error('无效键盘输入');
        if (!item.input) throw new Error('扩展界面尚未就绪');
        item.input(value); return;
      }
      if (cancel) item.settle(item.cancelValue);
      else if (item.request.kind === 'select') {
        if (!Number.isInteger(value) || value < 0 || value >= item.body.length) throw new Error('无效选项');
        item.settle(item.body[value]);
      } else if (item.request.kind === 'confirm') {
        if (typeof value !== 'boolean') throw new Error('需要确认结果');
        item.settle(value);
      } else {
        if (typeof value !== 'string') throw new Error('需要文本');
        item.settle(value);
      }
      pending.delete(id);
    },
    close() {
      for (const p of pending.values()) p.settle(p.cancelValue);
      pending.clear();
      for (const {kind, original, wrapper} of installed) if (ui[kind] === wrapper) ui[kind] = original;
    },
  };
}
