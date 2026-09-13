import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createAskUserAdapter } from './ask-user.ts';
import { bridgeDialogs } from './dialogs.ts';
import { startServer } from './server.ts';

const RELOAD_HANDOFF = Symbol.for('pi-atom-web.reload-handoff');
const INTERNAL_RELOAD_COMMAND = 'pi-atom-web-reload';
const THINKING_LEVELS = ['off','minimal','low','medium','high','xhigh','max'];

function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ['off'];
  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined;
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
    child.unref();
    const timer = setTimeout(() => resolve(true), 1500);
    timer.unref();
  });
}

export default function atomWeb(pi) {
  const instanceId = randomUUID();
  let context, server, starting, liveMessage = null, publishTimer, reloadFallbackTimer;
  const runningTools = new Map();
  const completedToolTimings = new Map();
  const askUser = createAskUserAdapter();
  pi.events.on('rpiv:ask-user:prompt', payload => askUser.prompt(payload));
  const displayRecords = [];
  let notificationBridge, dialogs;
  function recordDisplay(role, text, level) {
    const branch = context.sessionManager.getBranch();
    displayRecords.push({
      sessionId: context.sessionManager.getSessionId(),
      anchor: branch.at(-1)?.id ?? null,
      message: { role, content: stripVTControlCharacters(String(text)), level },
    });
    if (displayRecords.length > 500) displayRecords.shift();
    publish(context);
  }
  function detachNotifications() {
    const closing = dialogs; dialogs = undefined;
    closing?.close();
    if (!notificationBridge) return;
    const { ui, original, wrapper } = notificationBridge;
    if (ui.notify === wrapper) ui.notify = original;
    notificationBridge = undefined;
  }
  function attachNotifications() {
    const ui = context.ui;
    if (notificationBridge?.ui === ui) return;
    detachNotifications();
    const original = ui.notify;
    const wrapper = function(text, level) {
      const result = original.call(this, text, level);
      recordDisplay('notification', text, level);
      return result;
    };
    ui.notify = wrapper;
    notificationBridge = { ui, original, wrapper };
    dialogs = bridgeDialogs(ui, () => context.sessionManager.getSessionId(), () => publish(context), { takeAskUser: factory => askUser.take(factory) });
  }
  // Connection URLs contain credentials and must never enter the mirrored transcript.
  function notifyLocal(ctx, text, level) {
    const notify = notificationBridge?.ui === ctx.ui ? notificationBridge.original : ctx.ui.notify;
    notify.call(ctx.ui, text, level);
  }
  function displayMessages() {
    const records = displayRecords.filter(r => r.sessionId === context.sessionManager.getSessionId());
    const messages = records.filter(r => r.anchor === null).map(r => r.message);
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === 'message') messages.push(entry.message);
      messages.push(...records.filter(r => r.anchor === entry.id).map(r => r.message));
    }
    return messages;
  }
  function commands() {
    const available = pi.getCommands()
      .filter(command => command.name !== INTERNAL_RELOAD_COMMAND)
      .map(({ name, description, source }) => ({ name, description, source }));
    if (!available.some(command => command.name === 'reload')) {
      available.unshift({ name: 'reload', description: '重新加载 TUI 扩展并恢复 Web UI', source: 'builtin' });
    }
    const webCommands = [
      { name:'model', description:'打开 Web 模型选择器', source:'web' },
      { name:'session', description:'打开 Web 会话信息', source:'web' },
      { name:'copy', description:'复制最后一条助手文本', source:'web' },
      { name:'name', description:'设置会话名称：/name <名称>', source:'web' },
      { name:'compact', description:'压缩当前上下文：/compact [指令]', source:'web' },
    ];
    for (const command of webCommands) if (!available.some(item => item.name === command.name)) available.push(command);
    return available;
  }
  function sessionStats() {
    const branch = context.sessionManager.getBranch();
    const usage = {input:0, output:0, cacheRead:0, cacheWrite:0, total:0, cost:0};
    let rounds = 0, startedAt, activeAt;
    for (const entry of branch) {
      const message = entry.type === 'message' ? entry.message : null;
      if (message?.role === 'user') rounds++;
      const itemUsage = message?.usage ?? entry.usage;
      if (itemUsage) {
        for (const key of ['input','output','cacheRead','cacheWrite']) usage[key] += Number(itemUsage[key]) || 0;
        usage.cost += Number(itemUsage.cost?.total) || 0;
      }
      const rawTimestamp = entry.timestamp ?? message?.timestamp;
      const timestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.parse(rawTimestamp);
      if (Number.isFinite(timestamp) && (!startedAt || timestamp < startedAt)) startedAt = timestamp;
      if (Number.isFinite(timestamp) && (!activeAt || timestamp > activeAt)) activeAt = timestamp;
    }
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    return {
      rounds, events:branch.length, startedAt:startedAt || Date.now(), activeAt:activeAt || startedAt || Date.now(), usage,
      cacheHit:prompt ? usage.cacheRead / prompt : 0,
      workspace:{name:basename(context.cwd) || context.cwd, id:context.sessionManager.getSessionId(), path:context.cwd},
      sessionFile:typeof context.sessionManager.getSessionFile === 'function' ? context.sessionManager.getSessionFile() || '内存会话' : '内存会话',
    };
  }
  function modelOptions() {
    const scoped = context.scopedModels?.length ? context.scopedModels.map(item => item.model) : context.modelRegistry?.getAvailable?.() || [];
    return scoped.map(model => ({provider:model.provider, providerName:context.modelRegistry?.getProviderDisplayName?.(model.provider) || model.provider, id:model.id, name:model.name || model.id, reasoning:Boolean(model.reasoning), thinkingLevels:supportedThinkingLevels(model)}));
  }
  function snapshot() {
    return {
      sessionId: context.sessionManager.getSessionId(),
      instanceId,
      name: pi.getSessionName() || '未命名会话', cwd: context.cwd,
      model: context.model ? `${context.model.provider} / ${context.model.id}` : '未选择模型',
      selectedModel:context.model ? {provider:context.model.provider,id:context.model.id} : null,
      modelOptions:modelOptions(),
      thinkingLevels:supportedThinkingLevels(context.model),
      thinking: context.thinkingLevel || 'off', busy: !context.isIdle(),
      pending: context.hasPendingMessages(), commands: commands(),
      stats: sessionStats(),
      messages: displayMessages(),
      requests: dialogs?.list() || [],
      liveMessage, tools: [...runningTools.values()],
      toolTimings: Object.fromEntries(completedToolTimings),
    };
  }
  function publish(ctx) {
    context = ctx;
    if (server) attachNotifications();
    if (!publishTimer) publishTimer = setTimeout(() => {
      publishTimer = undefined;
      server?.publish();
    }, 32);
  }
  async function action(input) {
    if (!input || input.sessionId !== context.sessionManager.getSessionId()) throw new Error('TUI 已切换会话，请等待页面同步后重试');
    if (input.type === 'dialog_response') {
      if (!dialogs) throw new Error('插件请求已结束');
      dialogs.respond(input.id, input.value, input.cancel === true); return;
    }
    if (input.type === 'abort') { context.abort(); return; }
    if (input.type === 'select_model') {
      if (!context.isIdle()) throw new Error('请等待当前响应完成后再切换模型');
      const model = (context.scopedModels?.length ? context.scopedModels.map(item => item.model) : context.modelRegistry.getAvailable()).find(item => item.provider === input.provider && item.id === input.modelId);
      if (!model) throw new Error('模型不可用，请刷新后重试');
      if (!await pi.setModel(model)) throw new Error('模型认证不可用');
      publish(context); return;
    }
    if (input.type === 'select_thinking') {
      if (!context.isIdle()) throw new Error('请等待当前响应完成后再切换思考级别');
      const levels = supportedThinkingLevels(context.model);
      if (!levels.includes(input.level)) throw new Error('当前模型不支持该思考级别');
      pi.setThinkingLevel(input.level); publish(context); return;
    }
    if (input.type !== 'send' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('请输入消息');
    if (!['followUp', 'steer'].includes(input.mode)) throw new Error('无效的发送方式');
    const text = input.text.trim();
    if (text.startsWith('/')) {
      const name = text.slice(1).split(/\s/, 1)[0];
      if (!commands().some(command => command.name === name)) {
        throw new Error('未找到可执行命令；内置终端命令请在 TUI 中使用');
      }
      if (name === 'reload') {
        if (text !== '/reload') throw new Error('用法：/reload');
        if (!context.isIdle()) throw new Error('请等待当前响应完成后再重载');
        globalThis[RELOAD_HANDOFF] = server?.connection;
        clearTimeout(reloadFallbackTimer);
        reloadFallbackTimer = setTimeout(() => {
          if (globalThis[RELOAD_HANDOFF] === server?.connection) delete globalThis[RELOAD_HANDOFF];
        }, 5000);
        reloadFallbackTimer.unref();
        pi.sendUserMessage(`/${INTERNAL_RELOAD_COMMAND}`, { expandPromptTemplates: true });
        return { reloading: true };
      }
      const args = text.slice(name.length + 1).trim();
      if (name === 'name') {
        if (!args) throw new Error('用法：/name <名称>');
        pi.setSessionName(args); recordDisplay('command', text); publish(context); return;
      }
      if (name === 'compact') {
        if (!context.isIdle()) throw new Error('请等待当前响应完成后再压缩上下文');
        recordDisplay('command', text);
        context.compact({
          ...(args ? {customInstructions:args} : {}),
          onError:error => context.ui.notify(`上下文压缩失败：${error.message}`, 'error'),
        });
        publish(context); return;
      }
      if (['model','session','copy'].includes(name)) throw new Error(`/${name} 需要通过 Web 页面执行`);
      recordDisplay('command', text);
      pi.sendUserMessage(text, { deliverAs: input.mode, expandPromptTemplates: true });
    } else {
      pi.sendUserMessage(text, { deliverAs: input.mode });
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    liveMessage = null; runningTools.clear(); completedToolTimings.clear(); publish(ctx);
    const connection = globalThis[RELOAD_HANDOFF];
    if (!connection) return;
    delete globalThis[RELOAD_HANDOFF];
    try {
      starting = startServer({ snapshot, action, connection }).then(value => { server = value; });
      await starting;
      attachNotifications();
      notifyLocal(ctx, 'pi-atom-web 已随 /reload 恢复', 'info');
    } catch (error) {
      notifyLocal(ctx, `Web UI 恢复失败：${error.message}`, 'error');
    } finally { starting = undefined; }
  });
  for (const name of ['session_switch', 'session_fork', 'session_tree', 'session_compact']) {
    pi.on(name, (_event, ctx) => { liveMessage = null; runningTools.clear(); publish(ctx); });
  }
  for (const name of ['agent_start', 'agent_end', 'agent_settled', 'model_select', 'thinking_level_select']) {
    pi.on(name, (_event, ctx) => publish(ctx));
  }
  pi.on('message_update', (event, ctx) => { liveMessage = event.message; publish(ctx); });
  pi.on('message_end', (_event, ctx) => { liveMessage = null; publish(ctx); });
  pi.on('message_start', (_event, ctx) => publish(ctx));
  pi.on('tool_execution_start', (event, ctx) => {
    askUser.start(event);
    runningTools.set(event.toolCallId, {...event, startedAt:Date.now()});
    publish(ctx);
  });
  pi.on('tool_execution_update', (event, ctx) => {
    runningTools.set(event.toolCallId, {...runningTools.get(event.toolCallId), ...event});
    publish(ctx);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    askUser.end(event.toolCallId);
    const running = runningTools.get(event.toolCallId);
    const endedAt = Date.now();
    if (running?.startedAt) {
      completedToolTimings.set(event.toolCallId, {startedAt:running.startedAt, endedAt, durationMs:endedAt - running.startedAt});
      if (completedToolTimings.size > 500) completedToolTimings.delete(completedToolTimings.keys().next().value);
    }
    runningTools.delete(event.toolCallId);
    publish(ctx);
  });
  pi.on('session_shutdown', async () => {
    detachNotifications();
    displayRecords.length = 0;
    askUser.clear();
    clearTimeout(publishTimer); publishTimer = undefined;
    clearTimeout(reloadFallbackTimer); reloadFallbackTimer = undefined;
    if (starting) await starting;
    await server?.close(); server = undefined;
  });
  pi.registerCommand(INTERNAL_RELOAD_COMMAND, {
    description: 'pi-atom-web 内部重载桥接',
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
      } catch (error) {
        delete globalThis[RELOAD_HANDOFF];
        notifyLocal(ctx, `TUI 重载失败：${error.message}`, 'error');
      }
    },
  });
  pi.registerCommand('web', {
    description: '打开当前 TUI 会话的 Web UI（/web stop 关闭服务）',
    handler: async (args, ctx) => {
      context = ctx;
      if (ctx.mode !== 'tui') { notifyLocal(ctx, '/web 仅用于交互式 TUI', 'warning'); return; }
      if (args.trim() === 'stop') {
        if (starting) await starting;
        await server?.close(); server = undefined;
        detachNotifications();
        notifyLocal(ctx, 'pi-atom-web 已关闭', 'info'); return;
      }
      if (args.trim()) { notifyLocal(ctx, '用法：/web 或 /web stop', 'warning'); return; }
      try {
        if (!server) {
          starting ??= startServer({ snapshot, action }).then(value => { server = value; }).finally(() => { starting = undefined; });
          await starting;
        }
        attachNotifications();
        notifyLocal(ctx, `pi-atom-web · 当前会话\n${server.url}`, 'info');
        if (!await openBrowser(server.url)) notifyLocal(ctx, '未能自动打开浏览器，请打开上方地址', 'warning');
      } catch (error) { notifyLocal(ctx, `Web UI 启动失败：${error.message}`, 'error'); }
    },
  });
}
