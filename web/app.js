const $ = selector => document.querySelector(selector);
let token = location.hash.slice(1);
if (token) { sessionStorage.setItem('atom-token', token); history.replaceState(null, '', '/'); }
else token = sessionStorage.getItem('atom-token');
let state, connected = false, sending = false, view = 'chat';
const drafts = new Map();
const expanded = new Set();
const touchedThinking = new Set();
const thinkingRuns = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const iconPaths = {
  theme:'<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/>', chat:'<path d="M4 5h16v12H8l-4 3Z"/><path d="M8 9h8M8 13h6"/>',
  trace:'<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>', session:'<path d="M3 6h6l2 2h10v11H3Z"/>', up:'<path d="M12 18V6M7 11l5-5 5 5"/>', down:'<path d="M12 6v12M7 13l5 5 5-5"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/>', mode:'<path d="M8 5h8M6 9h12M8 13h8M10 17h4"/>',
  model:'<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M19 9h4M1 15h4M19 15h4"/>', thinking:'<path d="M9 18h6M10 22h4"/><path d="M8.5 15.5A7 7 0 1 1 15.5 15.5L14 18h-4Z"/>',
  stop:'<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>', send:'<path d="M12 20V5M6 11l6-6 6 6"/>', workspace:'<path d="M3 6h7l2 2h9v11H3Z"/>',
  conversation:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', tokens:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  cache:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M17.9 16A7 7 0 0 1 6 18l-2-6"/>', copy:'<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5H5v11h3"/>', check:'<path d="m5 12 4 4L19 6"/>'
};
function icon(name) { return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
function codeBlock(value, language = '') {
  const source = String(value ?? '');
  const requested = String(language || '').trim().split(/\s+/, 1)[0].toLowerCase();
  const known = requested && hljs.getLanguage(requested);
  const highlighted = known ? hljs.highlight(source, {language:requested, ignoreIllegals:true}).value : hljs.highlightAuto(source).value;
  const detected = known ? requested : highlighted.language || 'text';
  const lines = Math.max(1, source.split('\n').length);
  const numbers = Array.from({length:lines}, (_, index) => index + 1).join('\n');
  return `<div class="code-block"><div class="code-header"><span>${esc(detected)}</span><span>${lines} 行</span><button type="button" class="code-copy">复制</button></div><div class="code-scroll"><pre class="code-lines" aria-hidden="true">${numbers}</pre><pre class="code-source"><code class="hljs language-${esc(detected)}">${highlighted}</code></pre></div></div>`;
}
marked.use({renderer:{code({text, lang}) { return codeBlock(text, lang); }}});
const markdown = text => DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['img', 'style', 'input', 'form'], FORBID_ATTR: ['style'] });
function details(title, body, key) { return `<details data-key="${esc(key)}" ${expanded.has(String(key)) ? 'open' : ''}><summary>${esc(title)}</summary>${body}</details>`; }
function thinking(text, key, running) {
  const full = String(text || '');
  const compact = full.replace(/\s+/g, ' ').trim();
  let timing = thinkingRuns.get(String(key));
  if (running && !timing) {
    timing = {startedAt:Date.now()};
    thinkingRuns.set(String(key), timing);
  } else if (!running && timing && timing.durationMs == null) {
    timing = {...timing, durationMs:Date.now() - timing.startedAt};
    thinkingRuns.set(String(key), timing);
  }
  const open = touchedThinking.has(String(key)) ? expanded.has(String(key)) : running;
  return `<details class="thinking-block" data-key="${esc(key)}" ${open ? 'open' : ''}><summary><span class="thinking-row"><strong>Thinking</strong><span class="thinking-preview" data-full="${esc(compact)}">${esc(compact)}</span></span>${durationMarkup(timing, 'thinking-duration')}</summary><div class="body thinking-body">${markdown(full)}</div></details>`;
}
function toolCallId(value) { return value?.id ?? value?.toolCallId; }
function toolTitleArgument(args) {
  if (!args || typeof args !== 'object') return '';
  const value = args.command ?? args.path ?? args.query ?? args.prompt ?? args.url ?? args.file ?? args.pattern;
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
function toolResultBody(result) {
  if (!result) return '';
  if (typeof result.content === 'string') return markdown(result.content);
  return (result.content || []).map(block => {
    if (block.type === 'text') return markdown(block.text);
    if (block.type === 'image') return '<p class="muted">[图片内容]</p>';
    return `<pre>${esc(JSON.stringify(block, null, 2))}</pre>`;
  }).join('');
}
function formatToolDuration(value, detailed) {
  const total = Math.max(0, Math.round(value || 0));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total % 3600000 / 60000);
  const seconds = Math.floor(total % 60000 / 1000);
  const milliseconds = total % 1000;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  if (detailed) parts.push(`${milliseconds}ms`);
  return parts.join(' ');
}
function durationMarkup(timing, className) {
  const startedAt = timing?.startedAt;
  const duration = timing?.durationMs ?? (startedAt ? Date.now() - startedAt : null);
  if (duration == null) return `<span class="${className}">--</span>`;
  const attributes = timing?.durationMs == null && startedAt ? ` data-started-at="${esc(startedAt)}"` : '';
  return `<span class="${className}"${attributes}><span class="duration-collapsed">${formatToolDuration(duration, false)}</span><span class="duration-expanded">${formatToolDuration(duration, true)}</span></span>`;
}
function toolDuration(timing, running) {
  const startedAt = timing?.startedAt ?? running?.startedAt;
  return durationMarkup(timing || (startedAt ? {startedAt} : null), 'tool-duration');
}
function toolCard(call, result, running, timing, key) {
  const name = call?.name ?? call?.toolName ?? result?.toolName ?? running?.toolName ?? 'tool';
  const args = call?.arguments ?? call?.args ?? running?.args;
  const status = result ? (result.isError ? 'failure' : 'success') : 'running';
  const argument = toolTitleArgument(args);
  const input = args === undefined ? '' : `<section class="tool-io-section"><div class="tool-io-label">Input</div>${codeBlock(JSON.stringify(args, null, 2), 'json')}</section>`;
  const partial = running?.partialResult;
  const outputBody = result ? toolResultBody(result) : partial === undefined ? '' : `<pre>${esc(typeof partial === 'string' ? partial : JSON.stringify(partial, null, 2))}</pre>`;
  const output = outputBody ? `<section class="tool-io-section"><div class="tool-io-label">Output</div><div class="tool-output-frame">${outputBody}</div></section>` : '';
  return `<details class="tool-block tool-${status}" data-key="${esc(key)}" ${expanded.has(String(key)) ? 'open' : ''}><summary><span class="tool-title"><strong>${esc(name)}</strong>${argument ? `<span>${esc(argument)}</span>` : ''}</span>${toolDuration(timing, running)}</summary><div class="tool-body">${input}${output || (status === 'running' ? '<p class="tool-waiting">等待输出…</p>' : '')}</div></details>`;
}
let thinkingFitFrame;
function fitThinking(root = document) {
  for (const preview of root.querySelectorAll?.('.thinking-block:not([open]) .thinking-preview') || []) {
    const full = preview.dataset.full || '';
    preview.textContent = full;
    if (preview.scrollWidth <= preview.clientWidth) continue;
    let low = 0, high = full.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      preview.textContent = full.slice(0, middle).trimEnd() + '...';
      if (preview.scrollWidth <= preview.clientWidth) low = middle;
      else high = middle - 1;
    }
    preview.textContent = full.slice(0, low).trimEnd() + '...';
  }
}
function scheduleThinkingFit() {
  cancelAnimationFrame(thinkingFitFrame);
  thinkingFitFrame = requestAnimationFrame(() => fitThinking(document));
}
window.addEventListener('resize', () => scheduleThinkingFit());
function content(message, key, tools = {}, running = false) {
  if (typeof message.content === 'string') return markdown(message.content);
  return (message.content || []).map((block, i) => {
    if (block.type === 'text') return markdown(block.text);
    if (block.type === 'thinking') return thinking(block.thinking, `${key}-thinking-${i}`, running);
    if (block.type === 'toolCall') {
      const id = toolCallId(block);
      const result = id == null ? undefined : tools.results?.get(String(id));
      const running = id == null ? undefined : tools.running?.get(String(id));
      const timing = id == null ? undefined : tools.timings?.get(String(id));
      return toolCard(block, result, running, timing, id == null ? `${key}-call-${i}` : `tool-${id}`);
    }
    if (block.type === 'image') return '<p class="muted">[图片内容]</p>';
    return '';
  }).join('');
}
function messageHTML(m, i, tools = {}) {
  const messageKey = m.id ?? m.timestamp ?? i;
  if (m.role === 'command' || m.role === 'notification') {
    return `<article class="message ${m.role === 'command' ? 'user' : ''}"><div class="role">${m.role === 'command' ? '命令' : 'TUI 通知'}${m.level ? ` · ${esc(m.level)}` : ''}</div><div class="notification-text">${esc(m.content)}</div></article>`;
  }
  if (view === 'trace' && !['assistant', 'toolResult', 'bashExecution'].includes(m.role)) return '';
  if (m.role === 'toolResult') {
    const id = toolCallId(m);
    if (id != null && tools.calls?.has(String(id))) return '';
    const timing = id == null ? undefined : tools.timings?.get(String(id));
    return toolCard(null, m, null, timing, id == null ? `result-${messageKey}` : `tool-${id}`);
  }
  if (m.role === 'bashExecution') return details(`终端 · ${m.command}`, `<pre>${esc(m.output)}</pre>`, i);
  return `<article class="message ${m.role === 'user' ? 'user' : ''}">${m.role === 'user' ? '' : `<div class="role">${esc(m.role === 'assistant' ? 'pi' : m.role)}</div>`}<div class="body">${content(m, messageKey, tools, i === 'live')}${m.errorMessage ? `<p class="failure">${esc(m.errorMessage)}</p>` : ''}</div></article>`;
}
function toolContext(messages, runningTools = [], timingData = {}) {
  const calls = new Set(), results = new Map(), running = new Map(), timings = new Map(Object.entries(timingData || {}));
  for (const message of messages || []) {
    if (message.role === 'toolResult') {
      const id = toolCallId(message);
      if (id != null) results.set(String(id), message);
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) for (const block of message.content) {
      const id = block.type === 'toolCall' ? toolCallId(block) : null;
      if (id != null) calls.add(String(id));
    }
  }
  for (const event of runningTools || []) {
    const id = toolCallId(event);
    if (id != null) running.set(String(id), event);
  }
  return {calls, results, running, timings};
}
function updateRunningDurations(root = document) {
  const now = Date.now();
  for (const duration of root.querySelectorAll?.('[data-started-at]') || []) {
    const elapsed = now - Number(duration.dataset.startedAt);
    duration.querySelector('.duration-collapsed').textContent = formatToolDuration(elapsed, false);
    duration.querySelector('.duration-expanded').textContent = formatToolDuration(elapsed, true);
  }
}
setInterval(() => updateRunningDurations(document), 100);
const composeObserver = new ResizeObserver(entries => {
  const height = Math.ceil(entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect.height ?? 0);
  document.documentElement.style.setProperty('--compose-height', `${height}px`);
});
composeObserver.observe($('.compose-wrap'));
function resizePrompt() {
  const prompt = $('#prompt');
  const lineHeight = Number.parseFloat(getComputedStyle(prompt).lineHeight) || 22.4;
  const minimum = lineHeight * 2;
  prompt.style.height = `${minimum}px`;
  const wrap = $('.compose-wrap');
  const available = Math.max(minimum, $('#scroll').clientHeight - (wrap.scrollHeight - prompt.offsetHeight) - 12);
  const maximum = Math.min(lineHeight * 10, available);
  const height = Math.min(Math.max(prompt.scrollHeight, minimum), maximum);
  prompt.style.height = `${height}px`;
  prompt.style.overflowY = prompt.scrollHeight > height + 1 ? 'auto' : 'hidden';
}
window.addEventListener('resize', resizePrompt);
resizePrompt();
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }
}
async function copyCode(button) {
  const text = button.closest('.code-block')?.querySelector('.code-source code')?.textContent ?? '';
  await writeClipboard(text);
  button.textContent = '已复制';
  setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 1500);
}
document.addEventListener('click', event => {
  const button = event.target.closest?.('.code-copy');
  if (button) copyCode(button);
});
let commandMatches = [], commandIndex = 0, dismissedQuery = null;
function updateCommands(reset = false) {
  const query = $('#prompt').value;
  if (reset) { commandIndex = 0; dismissedQuery = null; }
  const match = /^\/([^\s]*)$/.exec(query);
  commandMatches = match && connected && dismissedQuery !== query
    ? (state?.commands || []).filter(c => c.name.toLowerCase().startsWith(match[1].toLowerCase())) : [];
  commandIndex = Math.min(commandIndex, Math.max(0, commandMatches.length - 1));
  const visible = Boolean(match && connected && dismissedQuery !== query);
  $('#command-menu').hidden = !visible;
  $('#prompt').setAttribute('aria-expanded', String(visible));
  $('#prompt').removeAttribute('aria-activedescendant');
  const emptyMessage = !Array.isArray(state?.commands)
    ? '当前连接的扩展未提供命令列表。旧版 JS 入口可能被 pi 缓存；更新为新版 TS 入口后，在 TUI 执行 /reload，再执行 /web。'
    : state.commands.length === 0
      ? '当前 pi 返回的命令列表为空，请在 TUI 执行 /reload 后重新打开 /web。'
      : '没有匹配命令；内置终端命令请在 TUI 中使用。';
  $('#command-list').innerHTML = commandMatches.map((c, i) => `<button type="button" role="option" id="command-${i}" data-command="${i}" aria-selected="${i === commandIndex}"><strong>/${esc(c.name)}</strong><span>${esc(c.description || c.source)}</span></button>`).join('') || `<p class="muted">${esc(emptyMessage)}</p>`;
  if (commandMatches.length) $('#prompt').setAttribute('aria-activedescendant', `command-${commandIndex}`);
}
function completeCommand(index) {
  const command = commandMatches[index];
  if (!command) return;
  $('#prompt').value = `/${command.name} `;
  resizePrompt();
  updateCommands(true);
  $('#prompt').focus();
}
$('#prompt').addEventListener('input', () => { resizePrompt(); updateCommands(true); });
$('#command-list').addEventListener('click', event => {
  const button = event.target.closest('[data-command]');
  if (button) completeCommand(Number(button.dataset.command));
});
let activeStatus, sessionInfoOpen = false, settingPicker, selectedProvider, modelQuery = '';
const compactNumber = value => {
  const number = Number(value) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 1 : 2).replace(/\.0+$/, '')}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(number));
};
function elapsedText(startedAt, endedAt = Date.now()) {
  const seconds = Math.max(0, Math.floor(((Number(endedAt) || Date.now()) - (Number(startedAt) || Date.now())) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours && `${hours}时`, (hours || minutes) && `${minutes}分`, `${rest}秒`].filter(Boolean).join(' ');
}
function detailRow(label, value, copyKey) {
  return `<div class="status-detail"><span>${esc(label)}</span><strong>${esc(value)}</strong>${copyKey ? `<button type="button" data-copy="${copyKey}" aria-label="复制${esc(label)}">${icon('copy')}</button>` : ''}</div>`;
}
const dateTimeText = value => new Date(Number(value) || Date.now()).toLocaleString('zh-CN', {hour12:false});
function renderSessionInfo() {
  const popover = $('#session-info-popover');
  if (!state?.stats || !sessionInfoOpen) { popover.hidden = true; return; }
  const stats = state.stats, workspace = stats.workspace || {};
  popover.innerHTML = `<div class="session-info-body">${detailRow('会话 ID', state.sessionId, 'session-id')}${detailRow('会话文件路径', stats.sessionFile, 'session-file')}${detailRow('所在工作区', workspace.name, 'workspace-name')}${detailRow('所在工作区路径', workspace.path, 'workspace-path')}${detailRow('活跃时间', dateTimeText(stats.activeAt), 'active-at')}${detailRow('创建时间', dateTimeText(stats.startedAt), 'started-at')}${detailRow('活跃时长', elapsedText(stats.startedAt, stats.activeAt))}</div>`;
  popover.hidden = false;
}
function renderSettingPickers() {
  const modelPicker = $('#model-picker'), thinkingPicker = $('#thinking-picker');
  modelPicker.hidden = settingPicker !== 'model';
  thinkingPicker.hidden = settingPicker !== 'thinking';
  $('#model-button').setAttribute('aria-expanded', String(settingPicker === 'model'));
  $('#thinking-button').setAttribute('aria-expanded', String(settingPicker === 'thinking'));
  if (!state) return;
  if (settingPicker === 'model') {
    const models = state.modelOptions || [];
    const providers = [...new Map(models.map(model => [model.provider, model.providerName || model.provider])).entries()];
    if (selectedProvider && !providers.some(([id]) => id === selectedProvider)) selectedProvider = undefined;
    const visible = models.filter(model => (!selectedProvider || model.provider === selectedProvider) && (!modelQuery || `${model.name} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase())));
    const modelButton = model => `<button type="button" data-provider-id="${esc(model.provider)}" data-model-id="${esc(model.id)}" class="${state.selectedModel?.provider === model.provider && state.selectedModel?.id === model.id ? 'selected' : ''}">${state.selectedModel?.provider === model.provider && state.selectedModel?.id === model.id ? icon('check') : ''}<span>${esc(model.name)}</span></button>`;
    const modelRows = selectedProvider
      ? visible.map(modelButton).join('')
      : providers.map(([id,name]) => {
          const items = visible.filter(model => model.provider === id);
          return items.length ? `<div class="model-provider-heading">${esc(name)}</div>${items.map(modelButton).join('')}` : '';
        }).join('');
    const signature = JSON.stringify([selectedProvider,modelQuery,state.selectedModel,models]);
    if (modelPicker.dataset.signature === signature) return;
    modelPicker.dataset.signature = signature;
    modelPicker.innerHTML = `<div class="model-providers"><strong>选择供应方</strong>${providers.map(([id,name]) => `<button type="button" data-provider="${esc(id)}" class="${selectedProvider === id ? 'selected' : ''}">${selectedProvider === id ? icon('check') : ''}${esc(name)}</button>`).join('')}<button type="button" data-provider="" class="show-all ${!selectedProvider ? 'selected' : ''}">${!selectedProvider ? icon('check') : ''}显示全部</button></div><div class="model-list"><strong>${selectedProvider ? esc(providers.find(([id]) => id === selectedProvider)?.[1] || selectedProvider) : '全部模型'}</strong><input id="model-filter" value="${esc(modelQuery)}" placeholder="筛选模型..." aria-label="筛选模型"><div class="model-options-scroll">${modelRows || '<p class="muted">没有匹配模型</p>'}</div></div>`;
  }
  if (settingPicker === 'thinking') {
    const labels = {off:'关闭',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'};
    const signature = JSON.stringify([state.thinking,state.thinkingLevels]);
    if (thinkingPicker.dataset.signature === signature) return;
    thinkingPicker.dataset.signature = signature;
    thinkingPicker.innerHTML = `<strong>思考级别</strong>${(state.thinkingLevels || ['off']).map(level => `<button type="button" data-thinking-level="${level}" class="${state.thinking === level ? 'selected' : ''}">${state.thinking === level ? icon('check') : ''}${labels[level] || level}</button>`).join('')}`;
  }
}
function renderStatus() {
  if (!state?.stats) return;
  const stats = state.stats, usage = stats.usage || {}, workspace = stats.workspace || {};
  const durationSeconds = Math.max(1, (Date.now() - stats.startedAt) / 1000);
  const speed = (Number(usage.output) || 0) / durationSeconds;
  const selectedOption = (state.modelOptions || []).find(item => item.provider === state.selectedModel?.provider && item.id === state.selectedModel?.id);
  const model = selectedOption?.name || String(state.model || '未选择模型').split('/').at(-1).trim();
  $('#composer-model').textContent = model;
  $('#composer-thinking').textContent = state.thinking || 'off';
  $('.composer-ready').classList.toggle('busy', Boolean(state.busy));
  renderSettingPickers();
  const statusBar = $('#session-status');
  if (!statusBar.firstElementChild) statusBar.innerHTML = `<button type="button" data-status="session">${icon('session')}<span data-status-value="session"></span></button><button type="button" data-status="conversation">${icon('conversation')}<span data-status-value="conversation"></span></button><button type="button" data-status="tokens">${icon('up')}<span data-status-value="input"></span>${icon('down')}<span data-status-value="output"></span>${icon('tokens')}<span data-status-value="total"></span></button><button type="button" data-status="cache">${icon('cache')}<span data-status-value="cache"></span></button>`;
  statusBar.querySelector('[data-status-value="session"]').textContent = state.name || '未命名会话';
  statusBar.querySelector('[data-status-value="conversation"]').textContent = `${stats.rounds}轮${stats.events}步 · ${speed.toFixed(1)} tok/s`;
  statusBar.querySelector('[data-status-value="input"]').textContent = compactNumber(usage.input);
  statusBar.querySelector('[data-status-value="output"]').textContent = compactNumber(usage.output);
  statusBar.querySelector('[data-status-value="total"]').textContent = compactNumber(usage.total);
  statusBar.querySelector('[data-status-value="cache"]').textContent = `${(stats.cacheHit * 100).toFixed(1)}%　$${(Number(usage.cost) || 0).toFixed(2)}`;
  renderSessionInfo();
  const popover = $('#status-popover');
  if (!activeStatus) { popover.hidden = true; return; }
  const titles = {session:`${icon('session')}会话信息`,conversation:`${icon('conversation')}对话与轨迹`,tokens:`${icon('tokens')}Token 用量`,cache:`${icon('cache')}缓存与成本`};
  let body = '';
  if (activeStatus === 'session') body = detailRow('会话 ID', state.sessionId, 'session-id') + detailRow('会话文件路径', stats.sessionFile, 'session-file') + detailRow('所在工作区', workspace.name, 'workspace-name') + detailRow('所在工作区路径', workspace.path, 'workspace-path') + detailRow('活跃时间', dateTimeText(stats.activeAt), 'active-at') + detailRow('创建时间', dateTimeText(stats.startedAt), 'started-at') + detailRow('活跃时长', elapsedText(stats.startedAt, stats.activeAt));
  if (activeStatus === 'conversation') body = detailRow('对话轮数', stats.rounds) + detailRow('轨迹事件数', stats.events) + detailRow('平均输出速度（估算）', `${speed.toFixed(1)} tok/s`) + detailRow('活跃时长', elapsedText(stats.startedAt));
  if (activeStatus === 'tokens') body = detailRow('输入', Number(usage.input || 0).toLocaleString(), 'usage-input') + detailRow('输出', Number(usage.output || 0).toLocaleString(), 'usage-output') + detailRow('缓存读取', Number(usage.cacheRead || 0).toLocaleString(), 'usage-cache-read') + detailRow('缓存写入', Number(usage.cacheWrite || 0).toLocaleString(), 'usage-cache-write') + detailRow('总计', Number(usage.total || 0).toLocaleString(), 'usage-total');
  if (activeStatus === 'cache') body = detailRow('缓存命中率', `${(stats.cacheHit * 100).toFixed(1)}%`) + detailRow('缓存读取 Token', Number(usage.cacheRead || 0).toLocaleString(), 'usage-cache-read') + detailRow('输入与缓存 Token', Number((usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)).toLocaleString(), 'usage-prompt') + detailRow('成本', `$${(Number(usage.cost) || 0).toFixed(4)}`, 'usage-cost');
  popover.innerHTML = `<div class="status-popover-title"><strong>${titles[activeStatus]}</strong><span>${activeStatus === 'conversation' ? `${speed.toFixed(1)} tok/s` : activeStatus === 'tokens' ? `${Number(usage.total || 0).toLocaleString()} tok` : activeStatus === 'cache' ? `$${(Number(usage.cost) || 0).toFixed(2)}` : ''}</span></div><div class="status-popover-body">${body}</div>`;
  popover.hidden = false;
}
setInterval(renderStatus, 1000);
$('#session-status').addEventListener('click', event => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  sessionInfoOpen = false;
  activeStatus = activeStatus === button.dataset.status ? undefined : button.dataset.status;
  renderStatus();
});
$('#status-popover').addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const values = {
    'session-id':state.sessionId,'session-file':state.stats.sessionFile,'active-at':dateTimeText(state.stats.activeAt),'started-at':dateTimeText(state.stats.startedAt),
    'workspace-name':state.stats.workspace.name,'workspace-id':state.stats.workspace.id,'workspace-path':state.stats.workspace.path,
    'usage-input':state.stats.usage.input,'usage-output':state.stats.usage.output,'usage-cache-read':state.stats.usage.cacheRead,
    'usage-cache-write':state.stats.usage.cacheWrite,'usage-total':state.stats.usage.total,
    'usage-prompt':state.stats.usage.input + state.stats.usage.cacheRead + state.stats.usage.cacheWrite,'usage-cost':state.stats.usage.cost,
  };
  await writeClipboard(String(values[button.dataset.copy] ?? ''));
  button.innerHTML = icon('check');
});
$('#session-info-button').addEventListener('click', () => {
  sessionInfoOpen = !sessionInfoOpen;
  activeStatus = undefined;
  renderStatus();
});
$('#session-info-popover').addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const stats = state.stats, workspace = stats.workspace || {};
  const values = {'session-id':state.sessionId,'session-file':stats.sessionFile,'workspace-name':workspace.name,'workspace-path':workspace.path,'active-at':dateTimeText(stats.activeAt),'started-at':dateTimeText(stats.startedAt)};
  await writeClipboard(String(values[button.dataset.copy] ?? ''));
  button.innerHTML = icon('check');
});
document.addEventListener('pointerdown', event => {
  if (activeStatus && !event.target.closest('#status-popover') && !event.target.closest('[data-status]')) { activeStatus = undefined; renderStatus(); }
  if (sessionInfoOpen && !event.target.closest('.aside-bottom')) { sessionInfoOpen = false; renderSessionInfo(); }
  if (settingPicker && !event.target.closest('.setting-picker') && !event.target.closest('.composer-setting')) { settingPicker = undefined; renderSettingPickers(); }
});
$('#model-button').addEventListener('click', () => {
  if (settingPicker === 'model') settingPicker = undefined;
  else {
    settingPicker = 'model'; modelQuery = '';
    const providers = [...new Set((state?.modelOptions || []).map(model => model.provider))];
    selectedProvider = state?.selectedModel?.provider || (providers.length === 1 ? providers[0] : undefined);
  }
  renderSettingPickers();
});
$('#thinking-button').addEventListener('click', () => { settingPicker = settingPicker === 'thinking' ? undefined : 'thinking'; renderSettingPickers(); });
$('#model-picker').addEventListener('input', event => { if (event.target.id === 'model-filter') { modelQuery = event.target.value; renderSettingPickers(); $('#model-filter')?.focus(); } });
$('#model-picker').addEventListener('click', async event => {
  const provider = event.target.closest('[data-provider]');
  if (provider) { selectedProvider = provider.dataset.provider || undefined; modelQuery = ''; renderSettingPickers(); return; }
  const model = event.target.closest('[data-model-id]');
  if (!model) return;
  try { await action({type:'select_model',sessionId:state.sessionId,provider:model.dataset.providerId,modelId:model.dataset.modelId}); settingPicker = undefined; renderSettingPickers(); }
  catch (error) { showError(error); }
});
$('#thinking-picker').addEventListener('click', async event => {
  const option = event.target.closest('[data-thinking-level]');
  if (!option) return;
  try { await action({type:'select_thinking',sessionId:state.sessionId,level:option.dataset.thinkingLevel}); settingPicker = undefined; renderSettingPickers(); }
  catch (error) { showError(error); }
});
function controls() {
  updateCommands();
  $('#send').disabled = !connected || sending;
  $('#stop').disabled = !connected;
  $('#stop').hidden = !state?.busy;
  $('#activity').textContent = !connected ? '连接已断开' : state?.busy ? `正在生成${state.pending ? ' · 有排队消息' : ''}` : state?.pending ? '消息已排队' : '已同步';
}
let historySignature = '', liveSignature = '';
function messageContainers() {
  const root = $('#messages');
  let history = $('#message-history');
  if (!history) {
    root.innerHTML = '<div id="message-history"></div><div id="message-live"></div><div id="message-empty" class="empty"><div class="symbol">π</div><h1>同一个 pi，新的视角。</h1><p>从这里继续，你的终端会同步这段对话。</p></div>';
    history = $('#message-history');
  }
  return {history,live:$('#message-live'),empty:$('#message-empty')};
}
function render(next) {
  const scroller = $('#scroll');
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  const changed = state?.sessionId !== next.sessionId;
  if (changed && state) { drafts.set(state.sessionId, $('#prompt').value); $('#prompt').value = drafts.get(next.sessionId) || ''; resizePrompt(); selectedProvider = undefined; modelQuery = ''; settingPicker = undefined; }
  state = next;
  renderRequests();
  $('#session-name').textContent = state.name;
  $('#cwd').textContent = state.cwd;
  $('#model').textContent = state.model;
  $('#thinking').textContent = state.thinking;
  renderStatus();
  document.title = `${state.name} · pi-atom-web`;
  const containers = messageContainers();
  const nextHistorySignature = JSON.stringify([view,state.messages,state.tools]);
  if (nextHistorySignature !== historySignature) {
    historySignature = nextHistorySignature;
    const tools = toolContext(state.messages, state.tools, state.toolTimings);
    containers.history.innerHTML = state.messages.map((message, index) => messageHTML(message, index, tools)).join('');
    scheduleThinkingFit(containers.history);
  }
  const nextLiveSignature = JSON.stringify([view,state.liveMessage,state.tools]);
  if (nextLiveSignature !== liveSignature) {
    liveSignature = nextLiveSignature;
    const liveMessages = state.liveMessage ? [state.liveMessage] : [];
    const tools = toolContext(liveMessages, state.tools, state.toolTimings);
    const allCalls = toolContext([...state.messages, ...liveMessages]).calls;
    let live = state.liveMessage ? messageHTML(state.liveMessage, 'live', tools) : '';
    live += state.tools.filter(t => !allCalls.has(String(toolCallId(t)))).map(t => toolCard(t, null, t, tools.timings.get(String(toolCallId(t))), `tool-${toolCallId(t)}`)).join('');
    containers.live.innerHTML = live;
    scheduleThinkingFit(containers.live);
  }
  containers.empty.hidden = Boolean(state.messages.length || state.liveMessage || state.tools.length);
  controls();
  if (atBottom || changed) scroller.scrollTop = scroller.scrollHeight;
}
$('#messages').addEventListener('toggle', event => {
  const key = event.target.dataset.key;
  if (key) event.target.open ? expanded.add(key) : expanded.delete(key);
  if (event.target.classList.contains('thinking-block') && !event.target.open) scheduleThinkingFit(event.target);
}, true);
function markThinkingTouched(event) {
  const summary = event.target.closest?.('.thinking-block > summary');
  if (summary?.parentElement?.dataset.key) touchedThinking.add(summary.parentElement.dataset.key);
}
$('#messages').addEventListener('pointerdown', markThinkingTouched);
$('#messages').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') markThinkingTouched(event);
});
async function action(payload) {
  const response = await fetch('/api/action', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body:JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
let noticeTimer;
function showError(error) { clearTimeout(noticeTimer); $('#error').classList.remove('notice'); $('#error').hidden = false; $('#error').textContent = error.message; }
function showNotice(text) {
  clearTimeout(noticeTimer); $('#error').classList.add('notice'); $('#error').hidden = false; $('#error').textContent = text;
  noticeTimer = setTimeout(() => { $('#error').hidden = true; $('#error').classList.remove('notice'); }, 1800);
}
function assistantPlainText(message) {
  if (!message || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n').trim();
}
function clearComposerPrompt() { $('#prompt').value = ''; resizePrompt(); updateCommands(true); }
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#prompt').value;
  if (!text.trim() || !connected || sending) return;
  const trimmed = text.trim();
  const localCommand = /^\/(model|session|copy)(?:\s+(.*))?$/.exec(trimmed);
  if (localCommand) {
    if (localCommand[2]) { showError(new Error(`用法：/${localCommand[1]}`)); return; }
    clearComposerPrompt();
    if (localCommand[1] === 'model') { if (settingPicker !== 'model') $('#model-button').click(); }
    if (localCommand[1] === 'session') { settingPicker = undefined; sessionInfoOpen = false; activeStatus = 'session'; renderStatus(); }
    if (localCommand[1] === 'copy') {
      const messages = [...(state.messages || []), ...(state.liveMessage ? [state.liveMessage] : [])];
      const value = messages.reverse().map(assistantPlainText).find(Boolean);
      if (!value) showError(new Error('当前会话没有可复制的助手文本'));
      else { await writeClipboard(value); showNotice('已复制最后一条助手文本'); }
    }
    return;
  }
  const sessionId = state.sessionId;
  const reloadRequested = trimmed === '/reload';
  if (reloadRequested) sessionStorage.setItem('atom-refresh-after-reload', state.instanceId || 'legacy');
  sending = true; controls(); $('#error').hidden = true;
  try {
    const result = await action({ type:'send', text, sessionId, mode:$('#mode').value });
    if (state.sessionId === sessionId && $('#prompt').value === text) { $('#prompt').value = ''; resizePrompt(); }
    drafts.delete(sessionId);
    if (result.reloading) {
      connected = false;
      $('#connection').textContent = '○ TUI 正在重载 · 等待 Web UI 恢复';
    }
  } catch (error) {
    if (reloadRequested && !(error instanceof TypeError)) sessionStorage.removeItem('atom-refresh-after-reload');
    showError(error);
  }
  finally { sending = false; controls(); }
});
$('#prompt').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (!$('#command-menu').hidden) {
    if (event.key === 'Escape') { event.preventDefault(); dismissedQuery = $('#prompt').value; updateCommands(); return; }
    if (commandMatches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) % commandMatches.length;
      updateCommands();
      $(`#command-${commandIndex}`).scrollIntoView({ block:'nearest' });
      return;
    }
    if (commandMatches.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault(); completeCommand(commandIndex); return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
});
$('#stop').onclick = () => action({ type:'abort', sessionId:state.sessionId }).catch(showError);
$('#bottom').onclick = () => { $('#scroll').scrollTop = $('#scroll').scrollHeight; };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
  $('#view-title').textContent = view === 'chat' ? '对话' : '执行轨迹';
  if (state) render(state);
};
try { document.documentElement.classList.toggle('dark', localStorage.getItem('atom-theme') === 'dark'); } catch {}
$('#theme').onclick = () => {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('atom-theme', dark ? 'dark' : 'light'); } catch {}
};
async function connect() {
  if (!token) { $('#connection').textContent = '未连接'; showError(new Error('请在 pi TUI 中执行 /web，使用完整地址打开页面。')); return; }
  while (true) {
    let reader;
    try {
      const response = await fetch('/api/events', { headers:{ Authorization:`Bearer ${token}` } });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error); }
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error('连接已断开');
        buffer += decoder.decode(value, { stream:true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (event.startsWith('data: ')) {
            const next = JSON.parse(event.slice(6));
            const reloadInstance = sessionStorage.getItem('atom-refresh-after-reload');
            if (reloadInstance && next.instanceId && next.instanceId !== reloadInstance) {
              sessionStorage.removeItem('atom-refresh-after-reload');
              location.reload();
              return;
            }
            connected = true; $('#connection').textContent = '● 已连接 TUI';
            render(next);
          }
        }
      }
    } catch (error) {
      connected = false; controls(); $('#connection').textContent = '○ 连接断开 · 正在重试';
      if (error.message.includes('凭证')) { showError(error); return; }
    } finally { await reader?.cancel().catch(() => {}); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
connect();

const customTerminals = new Map();
let terminalInputQueue = Promise.resolve();
function sendTerminalInput(id, value) {
  if (!connected) return;
  const sessionId = state.sessionId;
  terminalInputQueue = terminalInputQueue.catch(() => {}).then(async () => {
    for (let offset = 0; offset < value.length; offset += 4096) {
      await action({type:'dialog_response', id, sessionId, value:value.slice(offset, offset + 4096)});
    }
  }).catch(showError);
}
// Only SGR styling is accepted from render lines. OSC links, clipboard commands,
// cursor movement and other terminal controls are never executed in the browser.
function terminalLine(line) {
  return String(line).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, code => /^\x1b\[[0-9;:]*m$/.test(code) ? code : '')
    .replace(/\x1b(?!\[)[^]?/g, '').replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
}
function mountTerminal(card, request) {
  let item = customTerminals.get(request.id);
  if (!item) {
    const element = document.createElement('div');
    element.className = 'terminal-screen';
    const terminal = new Terminal({cols:80,rows:1,scrollback:0,convertEol:true,fontSize:14,
      fontFamily:'"Noto Sans Mono", "JetBrains Mono", "Fira Code", "Consolas", ui-monospace, "Microsoft YaHei", monospace',allowProposedApi:false,disableStdin:false,
      theme:{background:'#252a33',foreground:'#d8dee9',cursor:'#88c0d0'}});
    item = {terminal, element, lines:'', observer:null};
    customTerminals.set(request.id,item);
    terminal.onData(value => sendTerminalInput(request.id,value));
  }
  const host = card.querySelector('[data-terminal]');
  host.append(item.element);
  if (!item.terminal.element) item.terminal.open(item.element);
  const cols = Math.max(1, Math.min(1000, request.columns || 120));
  const lines = request.lines || [];
  item.terminal.resize(cols, Math.max(1,lines.length));
  const output = lines.map(terminalLine).join('\r\n');
  if (output !== item.lines) {
    item.lines = output;
    item.terminal.write('\x1b[0m\x1b[2J\x1b[H' + output);
  }
  const fit = () => {
    const screen = item.element.querySelector('.xterm-screen');
    const width = screen?.offsetWidth;
    if (!width || !host.clientWidth) return;
    const scale = Math.min(1, host.clientWidth / width);
    item.element.style.transform = `scale(${scale})`;
    host.style.height = `${screen.offsetHeight * scale}px`;
  };
  item.observer?.disconnect();
  item.observer = new ResizeObserver(fit);
  item.observer.observe(host);
  requestAnimationFrame(fit);
  host.onclick = () => item.terminal.focus();
}
let requestSignature = '';
function renderRequests() {
  const requests = state.requests || [];
  const signature = JSON.stringify(requests);
  if (signature === requestSignature) return;
  requestSignature = signature;
  AskUserForms.retain(requests.filter(r=>r.kind==='ask_user_question').map(r=>r.id));
  if (requests.length) dismissedQuery = $('#prompt').value;
  const focusedTerminal = [...customTerminals].find(([,t]) => t.element.contains(document.activeElement))?.[0];
  for (const item of customTerminals.values()) item.element.remove();
  const saved = new Map([...document.querySelectorAll('[data-request]')].map(card => [card.dataset.request, {
    open: card.querySelector('details')?.open,
    value: card.querySelector('textarea, input:not([type=radio]):not([type=checkbox])')?.value,
    focused: card.contains(document.activeElement) && document.activeElement.matches('textarea, input'),
  }]));
  $('#plugin-requests').innerHTML = requests.map(r => r.kind === 'ask_user_question' ? `<div class="plugin-request" data-request="${esc(r.id)}">${AskUserForms.render(r)}</div>` : `<div class="plugin-request" data-request="${esc(r.id)}"><div class="role">扩展请求 · ${esc(r.kind)}</div><strong>${esc(r.title)}</strong><details open><summary>展开 / 收起</summary>${r.kind === 'select' ? `<div class="request-options">${r.options.map((o,i) => `<button type="button" data-choice="${i}">${esc(o) || '&nbsp;'}</button>`).join('')}</div>` : `<p>${esc(r.text)}</p>`}${r.kind === 'custom' ? `<div class="terminal-host" data-terminal aria-label="可交互扩展终端"></div><p class="terminal-hint">点击终端后直接输入 · 支持方向键、Tab、退格及 Ctrl 组合键</p><div><button data-key="up">↑</button><button data-key="down">↓</button><button data-key="enter">Enter</button><button data-key="escape">Esc</button></div>` : ''}${r.kind === 'input' ? '<textarea aria-label="扩展请求输入"></textarea><button data-reply="input">提交</button>' : r.kind === 'confirm' ? '<button data-reply="confirm">确认</button>' : ''}${r.terminalOnly ? '<p>此请求需要在 TUI 编辑器中完成。</p>' : '<button data-reply="cancel">取消 / 关闭</button>'}<small>也可在 TUI 中操作</small></details></div>`).join('');
  for (const card of document.querySelectorAll('[data-request]')) {
    const request = requests.find(r => r.id === card.dataset.request);
    if (request.kind === 'ask_user_question') continue;
    if (request.kind === 'custom') mountTerminal(card, request);
    const previous = saved.get(card.dataset.request);
    if (!previous) continue;
    card.querySelector('details').open = previous.open;
    const input = card.querySelector('textarea, input:not([type=radio]):not([type=checkbox])');
    if (input && previous.value !== undefined) input.value = previous.value;
    if (input && previous.focused && request.kind !== 'custom') input.focus();
  }
  for (const [id,item] of customTerminals) {
    if (!requests.some(r => r.id === id && r.kind === 'custom')) {
      item.observer?.disconnect(); item.terminal.dispose(); customTerminals.delete(id);
    }
  }
  if (focusedTerminal) customTerminals.get(focusedTerminal)?.terminal.focus();
}
$('#plugin-requests').addEventListener('click', async event => {
  if (event.target.closest('.ask-user-form')) return;
  const button = event.target.closest('button');
  const card = button?.closest('[data-request]');
  if (!card || !connected) return;
  const cancel = button.dataset.reply === 'cancel';
  const key = {up:'\x1b[A',down:'\x1b[B',enter:'\r',escape:'\x1b'}[button.dataset.key];
  if (key) { sendTerminalInput(card.dataset.request,key); return; }
  const value = key ?? (button.hasAttribute('data-choice') ? Number(button.dataset.choice) : button.dataset.reply === 'confirm' ? true : card.querySelector('textarea')?.value);
  try { await action({ type:'dialog_response', id:card.dataset.request, sessionId:state.sessionId, value, cancel }); }
  catch(error) { showError(error); }
});


$('#plugin-requests').addEventListener('ask-user-submit', async event => {
  if (!connected) {showError(new Error('连接已断开，请重连后提交'));return;}
  const form = event.target;
  const {id,draft,cancel}=event.detail;
  form.querySelectorAll('button').forEach(b=>b.disabled=true);
  try {await action({type:'dialog_response',id,sessionId:state.sessionId,value:{draft},cancel});}
  catch(error) {showError(error);form.querySelectorAll('button').forEach(b=>b.disabled=false);}
});
