// Dedicated questionnaire UI. Drafts are tab-local and scoped to a request UUID.
window.AskUserForms = (() => {
  const drafts = new Map();
  const escape = text => String(text ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const md = text => DOMPurify.sanitize(marked.parse(text || ''), {FORBID_TAGS:['img','style','input','form'],FORBID_ATTR:['style']});
  function get(request) {
    if (!drafts.has(request.id)) {
      let saved;
      try {saved=JSON.parse(sessionStorage.getItem('ask-user:'+request.id));} catch {}
      const answers = Array.isArray(saved?.answers) && saved.answers.length===request.questions.length
        ? saved.answers : request.questions.map(q=>({kind:'unanswered',option:0,options:[],custom:false,text:'',notes:''}));
      request.questions.forEach((q,i)=>{
        if(q.multiSelect&&answers[i].kind==='custom')answers[i]={...answers[i],kind:'multi',options:[],custom:true};
        if(q.multiSelect&&answers[i].kind==='multi')answers[i]={custom:false,text:'',...answers[i]};
      });
      drafts.set(request.id,{request,answers,tab:0,previews:new Set()});
    }
    return drafts.get(request.id);
  }
  function save(state) {try {sessionStorage.setItem('ask-user:'+state.request.id,JSON.stringify({answers:state.answers}));}catch{}}
  function answerText(q,a) {
    if (a.kind==='unanswered') return '未回答';
    if (a.kind==='custom') return a.text || '空白自由回答';
    if (a.kind==='multi') return [...a.options.map(i=>q.options[i].label),...(a.custom&&a.text?[a.text]:[])].join('、') || '未选择任何选项';
    return q.options[a.option]?.label || '未回答';
  }
  function render(request) {
    const state=get(request), {answers,tab}=state;
    const review=tab===request.questions.length, single=request.questions.length===1;
    const tabs=request.questions.map((q,i)=>`<button type="button" data-ask-tab="${i}" aria-current="${tab===i}">${i+1}. ${escape(q.header)}${answers[i].kind!=='unanswered'?' ✓':''}</button>`).join('');
    let body;
    if(review) {
      const missing=answers.map((a,i)=>a.kind==='unanswered'?request.questions[i].header:null).filter(Boolean);
      body=`<h3>核对答案</h3>${request.questions.map((q,i)=>`<section class="ask-review"><strong>${escape(q.header)}</strong><div>${escape(answerText(q,answers[i]))}</div>${answers[i].notes?`<small>备注：${escape(answers[i].notes)}</small>`:''}<button type="button" data-ask-tab="${i}">修改</button></section>`).join('')}${missing.length?`<p class="ask-warning">尚未回答：${escape(missing.join('、'))}。可返回补充，或仅提交已填写答案；备注本身不算作答。</p>`:''}`;
    } else {
      const q=request.questions[tab],a=answers[tab],optionMode=q.multiSelect?'multi':'option';
      body=`<h3>${escape(q.question)}</h3><fieldset class="choice-options" aria-label="${q.multiSelect?'多选':'单选'}">${q.options.map((o,i)=>`<div class="ask-option"><label><input type="${q.multiSelect?'checkbox':'radio'}" name="answer-${escape(request.id)}" data-ask-option="${i}" ${a.kind===optionMode && (q.multiSelect?a.options.includes(i):a.option===i)?'checked':''}><span><strong>${escape(o.label)}</strong><small>${escape(o.description)}</small></span></label>${!q.multiSelect && o.preview?`<details class="ask-preview" ${state.previews.has(`${tab}:${i}`)?'open':''}><summary>查看 ${escape(o.label)} 的预览</summary><div class="body">${md(o.preview)}</div></details>`:''}</div>`).join('')}<div class="ask-option ask-custom-option"><label><input type="${q.multiSelect?'checkbox':'radio'}" name="custom-${escape(request.id)}" data-ask-custom ${q.multiSelect?(a.kind==='multi'&&a.custom?'checked':''):(a.kind==='custom'?'checked':'')}><span><textarea data-ask-text rows="2" maxlength="32000" aria-label="自行填写" placeholder="${q.multiSelect?'输入其他回答，可与上方选项同时选择':'输入自己的回答，替代上方选项'}">${escape(a.text)}</textarea></span></label></div></fieldset><div class="ask-extras"><details ${a.notes?'open':''}><summary>添加备注${a.notes?' · 已填写':''}</summary><label class="ask-field"><textarea data-ask-notes rows="2" maxlength="32000" aria-label="补充备注" placeholder="补充备注">${escape(a.notes)}</textarea></label></details></div>`;
    }
    return `<div class="ask-user-form ${state.collapsed?'ask-collapsed':''}" data-ask-id="${escape(request.id)}"><header class="ask-header"><span><strong class="ask-title">${review?'核对答案':escape(request.questions[tab].header)}</strong>${review?'':` <span class="muted">${tab+1} / ${request.questions.length} · ${request.questions[tab].multiSelect?'多选':'单选'}</span>`}</span><button type="button" data-ask-collapse>${state.collapsed?'展开':'收起'}</button></header><div class="ask-content">${!single?`<nav class="ask-tabs">${tabs}<button type="button" data-ask-tab="${request.questions.length}" aria-current="${review}">核对与提交</button></nav>`:''}${body}</div><footer class="ask-footer"><span class="spacer"></span>${!review?`<button type="button" class="ask-clear" data-ask-clear>清除选择</button>`:''}<button type="button" data-ask-cancel>取消问卷</button>${!review&&tab>0?`<button type="button" data-ask-tab="${tab-1}">上一题</button>`:''}${review||single?`<button type="button" class="primary" data-ask-submit ${single&&!review&&answers[0].kind==='unanswered'?'disabled':''}>提交答案</button>`:`<button type="button" class="primary" data-ask-tab="${tab+1}">${tab+1===request.questions.length?'核对答案':'下一题'}</button>`}</footer></div>`;
  }
  function replace(form,state) {
    const page=document.scrollingElement,conversation=document.querySelector('#scroll'),requests=document.querySelector('#plugin-requests');
    const content=form.querySelector('.ask-content');
    const positions={page:page?.scrollTop,conversation:conversation?.scrollTop,requests:requests?.scrollTop,content:content?.scrollTop};
    const template=document.createElement('template');
    template.innerHTML=render(state.request);
    const next=template.content.firstElementChild;
    form.replaceWith(next);
    const restore=()=>{
      if(page&&positions.page!==undefined)page.scrollTop=positions.page;
      if(conversation&&positions.conversation!==undefined)conversation.scrollTop=positions.conversation;
      if(requests&&positions.requests!==undefined)requests.scrollTop=positions.requests;
      const nextContent=next.querySelector('.ask-content');
      if(nextContent&&positions.content!==undefined)nextContent.scrollTop=positions.content;
    };
    restore();
    requestAnimationFrame(restore);
    return next;
  }
  document.addEventListener('toggle',event=>{
    if(!event.target.matches?.('.ask-preview')||!event.target.isConnected)return;
    const form=event.target.closest('[data-ask-id]'),option=event.target.closest('.ask-option');
    const state=form&&drafts.get(form.dataset.askId),index=option&&[...option.parentElement.children].indexOf(option);
    if(!state||index<0)return;
    const key=state.tab+':'+index;
    event.target.open?state.previews.add(key):state.previews.delete(key);
  },true);
  document.addEventListener('click',event=>{
    const button=event.target.closest('button'),form=button?.closest('[data-ask-id]');
    if(!form)return;
    const state=drafts.get(form.dataset.askId);if(!state)return;
    if(button.hasAttribute('data-ask-collapse')) {state.collapsed=!state.collapsed;replace(form,state);return;}
    if(button.hasAttribute('data-ask-clear')) {const notes=state.answers[state.tab].notes||'';state.answers[state.tab]={kind:'unanswered',option:0,options:[],custom:false,text:'',notes};save(state);replace(form,state);return;}
    if(button.hasAttribute('data-ask-tab')) {state.tab=Number(button.dataset.askTab);replace(form,state);return;}
    if(button.hasAttribute('data-ask-submit')||button.hasAttribute('data-ask-cancel')) {
      form.dispatchEvent(new CustomEvent('ask-user-submit',{bubbles:true,detail:{id:state.request.id,draft:structuredClone(state.answers),cancel:button.hasAttribute('data-ask-cancel')}}));
    }
  });
  document.addEventListener('change',event=>{
    const form=event.target.closest('[data-ask-id]');if(!form)return;
    const state=drafts.get(form.dataset.askId),a=state.answers[state.tab],q=state.request.questions[state.tab];
    if(event.target.hasAttribute('data-ask-mode')) {a.kind=event.target.dataset.askMode;save(state);replace(form,state);}
    if(event.target.hasAttribute('data-ask-option')) {
      if(q.multiSelect) {
        a.kind='multi';
        a.options=[...form.querySelectorAll('[data-ask-option]:checked')].map(el=>Number(el.dataset.askOption));
      } else {a.kind='option';a.option=Number(event.target.dataset.askOption);}
      save(state);replace(form,state);
    }
    if(event.target.hasAttribute('data-ask-custom')) {
      if(q.multiSelect) {
        a.kind='multi';a.custom=event.target.checked;
        a.options=[...form.querySelectorAll('[data-ask-option]:checked')].map(el=>Number(el.dataset.askOption));
      } else a.kind='custom';
      save(state);
      const next=replace(form,state);
      if(!q.multiSelect||a.custom)next.querySelector('[data-ask-text]')?.focus({preventScroll:true});
    }
  });
  document.addEventListener('focusin',event=>{
    if(!event.target.hasAttribute('data-ask-text'))return;
    const form=event.target.closest('[data-ask-id]');if(!form)return;
    const state=drafts.get(form.dataset.askId),a=state.answers[state.tab],q=state.request.questions[state.tab];
    if(q.multiSelect) {a.kind='multi';a.custom=true;a.options??=[];}
    else {if(a.kind==='custom')return;a.kind='custom';}
    form.querySelector('[data-ask-custom]').checked=true;
    if(!q.multiSelect)form.querySelectorAll('[data-ask-option]').forEach(el=>{el.checked=false;});
    const submit=form.querySelector('[data-ask-submit]');if(submit)submit.disabled=false;
    save(state);
  });
  document.addEventListener('input',event=>{
    const form=event.target.closest('[data-ask-id]');if(!form)return;
    const state=drafts.get(form.dataset.askId),a=state.answers[state.tab],q=state.request.questions[state.tab];
    if(event.target.hasAttribute('data-ask-text')) {
      a.text=event.target.value;
      if(q.multiSelect) {a.kind='multi';a.custom=true;a.options??=[];} else a.kind='custom';
      const submit=form.querySelector('[data-ask-submit]');if(submit)submit.disabled=false;
      form.querySelector('[data-ask-custom]').checked=true;
      if(!q.multiSelect)form.querySelectorAll('[data-ask-option]').forEach(el=>{el.checked=false;});
    }
    if(event.target.hasAttribute('data-ask-notes'))a.notes=event.target.value;
    save(state);
  });
  return {render,retain(ids) {
    try {for(const key of Object.keys(sessionStorage)) if(key.startsWith('ask-user:')&&!ids.includes(key.slice(9)))sessionStorage.removeItem(key);}catch{}
    for(const id of drafts.keys())if(!ids.includes(id)) {drafts.delete(id);try{sessionStorage.removeItem('ask-user:'+id);}catch{}}
  }};
})();
