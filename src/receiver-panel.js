import { renderMarkdown } from './receiver-markdown.mjs';
import { createWorkspacePicker } from './receiver-workspace-picker.js';

// DSH 客户端模块入口：由宿主提供 React 和原生会话导航。
window.__ModuleLoader__.load({
  id: 'dsh-gpt-receiver',
  factory: require => {
    const { createElement: h, useState, useEffect, useMemo, useRef } = require('react');
    const labels = { archived:'已归档', planning: 'GPT 规划中', needs_input: '待补充需求', dispatching: '正在派发', dispatched: '已派发 DSH', accepted: '已接收', running: '开发中', completed: '待 GPT 审查', failed: '执行失败', interrupted: '需要核查', approved: '审查通过', needs_changes: '需要返工' };
    const sourceLabel = source => `禅道${({task:'任务',bug:'Bug',story:'需求'})[source.kind] || ''} #${source.id}`;
    const status = job => job.archivedAt ? 'archived' : job.review?.verdict || job.status;
    const round = job => job.key.startsWith('request:') ? (job.source ? '禅道关联' : '新需求') : `第 ${job.key.split('-').at(-1)} 轮`;
    const active = job => ['planning', 'dispatching', 'dispatched', 'accepted', 'running'].includes(status(job));
    function Steps({ job }) {
      const current = status(job);
      return h('div', { className: 'gwr-steps', 'aria-label': '协作进度' }, ['GPT 方案', 'DSH 开发', 'GPT 审查'].map((text, index) => h('span', { key: text, className: (index === 0 && !!job.plan || index === 1 && ['completed','approved','needs_changes'].includes(current) || index === 2 && !!job.review) ? 'done' : '' }, `${index + 1}  ${text}`)));
    }
    function ActionFeedback({feedback}) {
      return feedback && h('div', {className:'gwr-feedback '+feedback.kind,role:feedback.kind==='error' ? 'alert' : 'status','aria-live':feedback.kind==='error' ? 'assertive' : 'polite'}, feedback.text);
    }
    function Details({ job, error, actionBusy, feedback, onAction, onClose, onOpenSession, onOpenGpt, onReuse }) {
      const dialog = useRef(null);
      const [tab, setTab] = useState('plan');
      const [copied, setCopied] = useState('');
      useEffect(() => { dialog.current.focus({ preventScroll: true }); }, []);
      const body = tab === 'plan' ? job.plan || (job.requirement ? `## 当前状态\n${job.error || labels[status(job)]}\n\n${job.scopeReason ? `## 仓库定位依据\n${job.scopeReason}\n\n` : ''}## 用户需求\n${job.requirement}` : '历史任务未保存方案副本，请打开开发会话查看。') : tab === 'answer' ? job.answer || job.error || '开发完成后会在这里显示结果。' : job.review?.summary || (job.source && job.key.startsWith('request:') ? '这是关联任务总览，请返回任务列表打开对应开发轮次查看审查证据。' : '等待 GPT 核对代码与测试证据，DSH 完成不等于审查通过。');
      const renderedBody = useMemo(() => renderMarkdown(body), [body]);
      const current = status(job);
      const gptBusy = job.status === 'planning' || ['starting','owned','release_failed'].includes(job.gptSessionState);
      return h('section', { ref: dialog, tabIndex: -1, role: 'dialog', 'aria-modal': false, className: 'gwr-panel gwr-modal', 'aria-label': `任务详情：${job.title}`, onKeyDown: e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
        h('header', null, h('div', { className: 'gwr-heading' }, h('strong', null, job.title), h('small', null, `${round(job)} · 任务详情`)), h('button', { onClick: onClose, 'aria-label': '关闭任务详情' }, '×')),
        h(ActionFeedback, {feedback}),
        error && h('p', { className: 'gwr-error', role: 'alert' }, error),
        h('div', { className: 'gwr-content' },
          h('div', { className: 'gwr-job' }, h('span', { className: `gwr-badge ${current}` }, labels[current] || current), h('div', {className:'gwr-actions'}, job.gptThreadId && h('button', {className:'gwr-primary',onClick:onOpenGpt,disabled:gptBusy,title:gptBusy ? '规划进程占用会话，请在面板查看进展，释放后再打开' : undefined}, gptBusy ? 'GPT 会话占用中' : '打开 GPT 会话'), job.sessionId && h('button', { onClick: onOpenSession }, '打开开发会话'))),
          h('p', { className: 'gwr-repo' }, job.repo),
          job.source?.provider === 'zentao' && h('p', {className:'gwr-source'}, h('a', {href:job.source.url,target:'_blank',rel:'noreferrer'}, `${sourceLabel(job.source)} · ${job.source.title}`)),
          h('div', { className: 'gwr-actions' }, job.requirement && h('button', { onClick: onReuse }, '复用需求新建'), job.sessionId && current === 'completed' && h('button', { onClick: async () => { try { await navigator.clipboard.writeText(`请使用 dsh-gpt-workflow 审查任务 ${job.key.replace(/-\d+$/, '')}，仓库 ${job.repo}。先读取 workflow_result 中的 diff、新文件和测试证据，再提交 GPT 审查结论。`); const opened = job.gptThreadId ? await onOpenGpt() : false; setCopied(opened ? '已复制并打开原 GPT 会话，粘贴发送即可审查' : '已复制，粘贴到 Codex 即可审查'); } catch { setCopied('复制失败，请在 Codex 中按任务名称继续审查'); } } }, job.gptThreadId ? '复制审查指令并打开 GPT' : '复制 GPT 审查指令')),
          h('div', {className:'gwr-actions'}, (job.availableActions || []).map(action => h('button', {key:action,disabled:actionBusy,onClick:()=>onAction(action)}, ({recover:'异常恢复',retry:'重试',archive:'归档',restore:'恢复显示'})[action]))),
          job.actionError && h('small', null, job.actionError),
          job.history?.length>0 && h('details', null, h('summary',null, '历史规划记录'), job.history.map((old,index)=>h('p',{key:index}, '第 '+(old.generation||1)+' 次：'+(old.error || labels[old.status] || old.status)))),
          copied && h('small', { role: 'status' }, copied),
          job.status === 'planning' && h('p', { className: 'gwr-hint', role: 'status' }, job.gptProgress || 'GPT 正在规划，结束后可打开会话。'),
          h(Steps, { job }),
          h('nav', { className: 'gwr-tabs', 'aria-label': '任务详情' }, [['plan', '实施方案'], ['answer', '开发结果'], ['review', 'GPT 审查']].map(([key, title]) => h('button', { key, onClick: () => setTab(key), 'aria-pressed': tab === key, className: tab === key ? 'active' : '' }, title))),
          h('div', { key: tab, className: 'gwr-detail gwr-markdown', dangerouslySetInnerHTML: { __html: renderedBody } }),
          job.permissionPreset && h('small', { className: 'gwr-permission' }, `完成时访问模式：${job.permissionPreset}`),
        ),
        h('footer', null, '仅由 GPT 提交审查结论'),
      );
    }
    const WorkspacePicker = createWorkspacePicker({createElement:h,useState,useEffect});
    function Panel({ ctx }) {
      const [open, setOpen] = useState(false), [jobs, setJobs] = useState([]), [selected, select] = useState(''), [error, setError] = useState('');
      const [workspaceReady, setWorkspaceReady] = useState(false);
      const [creating, setCreating] = useState(false), [workspace, setWorkspace] = useState(''), [requirement, setRequirement] = useState(''), [submitting, setSubmitting] = useState(false), [formError, setFormError] = useState(''), [filter, setFilter] = useState('all'), [query, setQuery] = useState(''), [loading, setLoading] = useState(true);
      const submission = useRef(null), busySubmit = useRef(false);
      const [linkedRequest, setLinkedRequest] = useState('');
      const [actionBusy,setActionBusy]=useState(false), [actionFeedback,setActionFeedback]=useState(null), [refreshTick,setRefreshTick]=useState(0);
      const actionLock=useRef(false);
      const [page,setPage]=useState(0), [hasMore,setHasMore]=useState(false);
      useEffect(() => {
        const showLinked = event => {
          const id=event.detail?.requestId;
          if (typeof id!=='string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return;
          setLinkedRequest(id); select(`request:${id}`); setCreating(false); setQuery(''); setFilter('all'); setOpen(true);
        };
        document.addEventListener('dsh-gpt:show',showLinked);
        return () => document.removeEventListener('dsh-gpt:show',showLinked);
      }, []);
      // 同页工作台一次只展开一个；收起只隐藏界面，保留需求草稿与选中任务。
      useEffect(() => {
        const onWorkbenchOpen = event => {
          if (event.detail?.id === 'zentao-workbench') setOpen(false);
        };
        document.addEventListener('dsh-workbench:open', onWorkbenchOpen);
        return () => document.removeEventListener('dsh-workbench:open', onWorkbenchOpen);
      }, []);
      useEffect(() => {
        if (open) document.dispatchEvent(new CustomEvent('dsh-workbench:open', { detail: { id: 'gpt-workflow-receiver' } }));
      }, [open]);
      const submit = async e => {
        e.preventDefault(); if (busySubmit.current) return;
        if (!workspaceReady) { setFormError('请在任务空闲时完整重启 DSH，以加载自动识别工作区的新接口'); return; }
        if (!workspace.trim()) { setFormError('请先选择工作区'); return; }
        busySubmit.current = true; setSubmitting(true); setFormError('');
        const payload = { workspace: workspace.trim(), requirement: requirement.trim() };
        const signature = JSON.stringify(payload);
        if (submission.current?.signature !== signature) submission.current = { signature, id: crypto.randomUUID() };
        try {
          const response = await fetch('/gpt-workflow-view/requests', { method: 'POST', headers: { 'X-GPT-Workflow-View': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: submission.current.id, ...payload }), signal: AbortSignal.timeout(15000) });
          const item = await response.json(); if (!response.ok) throw new Error(item.error || `提交失败（${response.status}）`);
          setJobs(old => [item, ...old.filter(j => j.key !== item.key)]); setCreating(false); setRequirement(''); submission.current = null; setFilter('all'); setQuery('');
        } catch (e) { setFormError(e.message); }
        finally { busySubmit.current = false; setSubmitting(false); }
      };
      useEffect(() => {
        if (!open) return;
        let stopped = false, busy = false;
        const refresh = async () => {
          if (busy) return; busy = true;
          try {
            let data;const collected=[];
            for(let currentPage=0;currentPage<=(linkedRequest ? 0 : page);currentPage++){
              const response=await fetch(linkedRequest ? '/gpt-workflow-view/linked' : '/gpt-workflow-view',{method:'POST',headers:{'X-GPT-Workflow-View':'1','Content-Type':'application/json'},body:JSON.stringify(linkedRequest ? {requestId:linkedRequest} : {view:filter==='archived' ? 'archived' : 'active',offset:currentPage*100}),signal:AbortSignal.timeout(8000)});
              if(!response.ok)throw new Error('接收插件暂不可用（'+response.status+'）');
              data=await response.json();if(!Array.isArray(data.jobs))throw new Error('任务列表响应无效');collected.push(...data.jobs);
              if(!data.hasMore)break;
            }
            data={...data,jobs:[...new Map(collected.map(job=>[job.key,job])).values()]};
            if (!Array.isArray(data.jobs)) throw new Error('任务列表响应无效，请检查接收插件版本');
            if (!stopped) { setJobs(data.jobs); setHasMore(!!data.hasMore); if(linkedRequest && data.focusKey && data.jobs.some(j=>j.key===data.focusKey)) select(old=>old===`request:${linkedRequest}` ? data.focusKey : old); setWorkspaceReady(data.workspaceRequests === true); setError(''); setLoading(false); }
          } catch (e) { if (!stopped) { setError(e.message); setLoading(false); } }
          finally { busy = false; }
        };
        void refresh(); const timer = setInterval(refresh, 2500);
        return () => { stopped = true; clearInterval(timer); };
      }, [open, linkedRequest, refreshTick, filter, page]);
      const job = jobs.find(j => j.key === selected);
      const onAction = async action => {
        if (actionLock.current || !job) return;
        actionLock.current=true;setActionBusy(true);setError('');setActionFeedback({key:job.key,kind:'pending',text:'正在'+({recover:'核对异常状态',retry:'提交重试',archive:'归档',restore:'恢复显示'})[action]+'…'});
        try {
          const response=await fetch('/gpt-workflow-view/actions',{method:'POST',headers:{'X-GPT-Workflow-View':'1','Content-Type':'application/json'},body:JSON.stringify({key:job.key,action,version:job.actionVersion}),signal:AbortSignal.timeout(45000)});
          const data=await response.json();if(!response.ok)throw new Error(data.error || '操作失败');
          setActionFeedback({key:job.key,kind:'success',text:data.notice});setPage(0);if(action==='archive')setFilter('archived');if(action==='restore')setFilter('all');
        } catch(error) {setActionFeedback({key:job.key,kind:'error',text:error.message+'；请核对任务状态，不会自动重复提交。'});}
        finally {actionLock.current=false;setActionBusy(false);setRefreshTick(value=>value+1);}
      };
      const openGpt = async () => {
        try {
          const response=await fetch('/gpt-workflow-view/open-gpt',{method:'POST',headers:{'X-GPT-Workflow-View':'1','Content-Type':'application/json'},body:JSON.stringify({key:job.key}),signal:AbortSignal.timeout(20000)});
          const data=await response.json(); if (!response.ok) throw new Error(data.error || '无法打开 Codex');
          setError(''); return true;
        } catch(e) {setError(`打开 GPT 会话失败：${e.message}。请确认 Codex 桌面版已安装。`); return false;}
      };
      const visible = jobs.filter(j => (filter==='archived' ? !!j.archivedAt : !j.archivedAt) && (!query || `${j.title} ${j.repo} ${j.source?.id || ''} ${j.source?.title || ''}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'archived' || filter === 'active' && active(j) || filter === 'review' && status(j) === 'completed')).sort((a, b) => Number(active(b)) - Number(active(a)));
      const openSession = async () => {
        try {
          const ui = ctx.get('uiWorkspace');
          if (!ui?.openSession) throw new Error('会话导航尚未就绪，请从左侧工作区打开该会话');
          await ui.openSession(job.sessionId); select(''); setOpen(false);
        } catch (e) { setError(e.message); }
      };
      return h('div', { className: 'gwr-root' },
        h('style', null, css),
        h('button', { className: 'gwr-launcher', title: 'GPT 协作工作台', 'aria-label': 'GPT 协作工作台', onClick: () => setOpen(!open) }, 'GPT'),
        open && h('section', { className: 'gwr-panel gwr-compact', 'aria-label': 'GPT 任务与进度' },
          h('header', null, h('strong', null, 'GPT 任务与进度'), h('div', { className: 'gwr-actions' }, h('button', { className: 'gwr-primary', onClick: () => { select(''); setWorkspace(''); setCreating(true); setFormError(''); } }, '+ 新建'), h('button', { onClick: () => setOpen(false), 'aria-label': '收起 GPT 工作台' }, '×'))),
          linkedRequest && h('button', {onClick:()=>{setLinkedRequest('');select('');}}, '返回全部任务'),
          error && h('p', { className: 'gwr-error', role: 'alert' }, error),
          h('div', { className: 'gwr-toolbar' }, h('input', { type: 'search', placeholder: '搜索任务或仓库', 'aria-label': '搜索任务或仓库', value: query, onChange: e => setQuery(e.target.value) }), h('nav', { className: 'gwr-filters', 'aria-label': '任务筛选' }, [['all','全部'],['active','进行中'],['review','待审查'],['archived','已归档']].map(([key, title]) => h('button', { key, 'aria-pressed': filter === key, onClick: () => {setFilter(key);setPage(0);} }, title)))),
          h(ActionFeedback, {feedback:actionFeedback}),
          hasMore && !linkedRequest && h('button',{onClick:()=>setPage(value=>value+1)},'加载更多任务'),
          !visible.length ? h('div', { className: 'gwr-empty' }, loading ? '正在加载任务…' : jobs.length ? '没有匹配任务' : '点击「新建」填写需求，交给 GPT 规划') : h('div', { className: 'gwr-task-list' }, visible.map(j => h('button', { key: j.key, className: 'gwr-task-card', onClick: () => { setCreating(false); select(j.key); }, 'aria-label': `查看任务：${j.title}，${round(j)}，${labels[status(j)] || status(j)}` },
            h('span', { className: 'gwr-task-title' }, j.title),
            j.source?.provider==='zentao' && h('small', {className:'gwr-source'}, sourceLabel(j.source)),
            h('span', { className: 'gwr-task-meta' }, h('span', { title: j.repo }, `${j.repo.split(/[\\/]/).at(-1)} · ${round(j)}`), h('span', { className: `gwr-badge ${status(j)}` }, labels[status(j)] || status(j))),
            h(Steps, { job: j }),
          ))),
        ),
        open && job && h(Details, { key: job.key, job, error, actionBusy, feedback:actionFeedback?.key===job.key ? actionFeedback : null, onAction, onClose: () => select(''), onOpenSession: openSession, onOpenGpt:openGpt, onReuse: () => { setWorkspace(job.workspace || job.repo); setRequirement(job.requirement); setFormError(''); select(''); setCreating(true); } }),
        open && creating && h('section', { className: 'gwr-panel gwr-create', role: 'dialog', 'aria-modal': false, 'aria-label': '新建 GPT 开发任务', onKeyDown: e => { if (e.key === 'Escape' && !submitting) { e.stopPropagation(); setCreating(false); } } },
          h('header', null, h('strong', null, '新建 GPT 开发任务'), h('button', { onClick: () => setCreating(false), 'aria-label': '关闭新建任务' }, '×')),
          h('form', { className: 'gwr-form', onSubmit: submit },
            h(WorkspacePicker, { ctx, value: workspace, onChange: setWorkspace, disabled: submitting }),
            h('label', null, '需求描述', h('textarea', { required: true, disabled: submitting, maxLength: 20000, rows: 7, value: requirement, onChange: e => setRequirement(e.target.value), placeholder: '希望改什么、现在有什么问题、怎样算完成？' })),
            h('p', { className: 'gwr-hint' }, 'GPT 读取代码生成方案后，自动交给 DSH 开发。需本机 Codex 已登录，自动识别的相关仓库须无未提交改动。'),
            formError && h('p', { className: 'gwr-error', role: 'alert' }, formError),
            h('button', { type: 'submit', className: 'gwr-primary', disabled: submitting }, submitting ? '正在提交…' : '交给 GPT 规划并开发'),
          ),
        ),
      );
    }
    // 工作台使用成对的自有前景/背景色，避免宿主按钮 foreground（白色）
    // 与宿主面板背景（白色）混用，导致浅色主题文字全部不可见。
    const css = `
.gwr-root{--gwr-surface:#ffffff;--gwr-surface-subtle:#f6f8fb;--gwr-surface-hover:#eef2f7;--gwr-text:#1b2430;--gwr-text-secondary:#52606d;--gwr-text-muted:#7b8794;--gwr-border:#e3e8ef;--gwr-border-strong:#cbd2d9;--gwr-accent:#0f766e;--gwr-accent-soft:#0f766e14;--gwr-accent-border:#0f766e47;--gwr-shadow:0 20px 52px -12px rgba(15,23,42,.22),0 4px 16px -4px rgba(15,23,42,.08);--gwr-card-shadow:0 1px 3px rgba(15,23,42,.05),0 1px 2px rgba(15,23,42,.03);position:fixed;inset:0;pointer-events:none;z-index:45;font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",sans-serif);color:var(--gwr-text);color-scheme:light}
.gwr-launcher{position:absolute;right:78px;bottom:18px;width:48px;height:48px;border-radius:50%;border:1px solid var(--gwr-accent-border);background:linear-gradient(145deg,var(--gwr-surface),var(--gwr-surface-subtle));color:var(--gwr-accent);box-shadow:0 6px 20px rgba(15,118,110,.18),0 2px 6px rgba(15,23,42,.08);font-size:13px;font-weight:750;letter-spacing:.03em;cursor:pointer;pointer-events:auto;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s ease,border-color .18s ease}
.gwr-launcher:hover{transform:translateY(-2px);border-color:var(--gwr-accent);box-shadow:0 10px 26px rgba(15,118,110,.26),0 4px 10px rgba(15,23,42,.1)}
.gwr-panel{position:absolute;right:18px;bottom:78px;width:460px;max-width:calc(100vw - 36px);height:610px;max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:var(--gwr-surface);color:var(--gwr-text);border:1px solid var(--gwr-border);border-radius:18px;box-shadow:var(--gwr-shadow);pointer-events:auto;overflow:hidden}
.gwr-panel header{padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--gwr-border);background:linear-gradient(180deg,var(--gwr-surface-subtle),var(--gwr-surface))}.gwr-panel strong{font-size:16px;font-weight:650;letter-spacing:-.01em}.gwr-panel small{display:block;font-size:12px;color:var(--gwr-text-secondary);margin-top:4px;line-height:1.45}.gwr-panel button{font:inherit;font-size:12px;font-weight:500;color:var(--gwr-text);cursor:pointer;border:1px solid var(--gwr-border-strong);background:var(--gwr-surface);border-radius:8px;padding:6px 12px;transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease,transform .12s ease;box-shadow:0 1px 2px rgba(15,23,42,.03)}.gwr-panel button:hover:where(:not(:disabled)){background:var(--gwr-surface-hover);border-color:var(--gwr-accent-border)}.gwr-panel button:active:where(:not(:disabled)){transform:translateY(.5px)}.gwr-panel header button{font-size:20px;line-height:1;padding:3px 9px;border:1px solid transparent;border-radius:8px;color:var(--gwr-text-secondary);background:transparent;box-shadow:none}.gwr-panel header button:hover:where(:not(:disabled)){background:var(--gwr-surface-hover);color:var(--gwr-text);border-color:var(--gwr-border)}.gwr-content{padding:16px 20px;min-height:0;flex:1;display:flex;flex-direction:column}.gwr-label{font-size:12px;color:var(--gwr-text-secondary)}.gwr-label select{display:block;width:100%;padding:9px 11px;margin:6px 0 14px;background:var(--gwr-surface);color:var(--gwr-text);border:1px solid var(--gwr-border-strong);border-radius:9px;font:inherit;font-size:13px}.gwr-job{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}.gwr-badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:#f59e0b1f;color:#b45309;border:1px solid #f59e0b40;font-size:11px;font-weight:600;line-height:1.35;flex-shrink:0}.gwr-badge.running,.gwr-badge.planning,.gwr-badge.dispatching,.gwr-badge.dispatched,.gwr-badge.accepted{background:#3b82f61c;color:#1d4ed8;border-color:#3b82f640}.gwr-badge.approved{background:#10b9811f;color:#047857;border-color:#10b98147}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes{background:#ef44441c;color:#b91c1c;border-color:#ef444442}.gwr-badge.archived{background:#64748b1f;color:var(--gwr-text-secondary);border-color:var(--gwr-border-strong)}.gwr-panel .gwr-primary{background:linear-gradient(180deg,#118279,#0f766e);color:#fff;border:1px solid #0d655e;font-size:12px;font-weight:600;box-shadow:0 2px 6px rgba(15,118,110,.24)}.gwr-panel .gwr-primary:hover:where(:not(:disabled)){background:linear-gradient(180deg,#0f766e,#0b5c56);color:#fff;border-color:#0b5c56}.gwr-repo{font:11.5px/1.5 Consolas,"Cascadia Code",monospace;color:var(--gwr-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:8px 0 12px}.gwr-steps{display:flex;gap:6px;font-size:11px;margin-bottom:14px}.gwr-steps span{flex:1;padding:6px 4px;text-align:center;border-radius:7px;background:var(--gwr-surface-subtle);border:1px solid var(--gwr-border);border-bottom:2px solid var(--gwr-border-strong);color:var(--gwr-text-muted);font-weight:500;transition:all .15s ease}.gwr-steps .done{background:var(--gwr-accent-soft);border-color:var(--gwr-accent-border);border-bottom-color:var(--gwr-accent);color:var(--gwr-accent);font-weight:600}.gwr-tabs{display:flex;border-bottom:1px solid var(--gwr-border);gap:6px;flex-shrink:0;overflow-x:auto}.gwr-panel .gwr-tabs button{border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;font-size:12.5px;font-weight:500;color:var(--gwr-text-secondary);padding:8px 14px;background:transparent;box-shadow:none;white-space:nowrap}.gwr-panel .gwr-tabs button:hover:where(:not(:disabled)){color:var(--gwr-text);background:var(--gwr-surface-subtle)}.gwr-panel .gwr-tabs .active{border-bottom:2px solid var(--gwr-accent);color:var(--gwr-accent);background:var(--gwr-accent-soft);font-weight:650}.gwr-detail{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;flex:1;overflow:auto;margin:0;padding:16px 0;min-height:100px}.gwr-panel footer{display:flex;justify-content:space-between;padding:11px 20px;border-top:1px solid var(--gwr-border);background:var(--gwr-surface-subtle);font-size:11px;color:var(--gwr-text-muted)}.gwr-error{background:#ef444414;color:#b91c1c;border:1px solid #ef444438;margin:10px 16px;padding:10px 12px;border-radius:9px;font-size:12px;line-height:1.55}.gwr-empty{padding:48px 28px;text-align:center;flex:1;color:var(--gwr-text-secondary);background:var(--gwr-surface-subtle)}.gwr-empty p{font-size:13px;line-height:1.8}
.gwr-panel,.gwr-label select{background:var(--gwr-surface);color:var(--gwr-text)}
.gwr-compact{width:380px;height:720px;max-height:calc(100vh - 110px)}.gwr-compact>header,.gwr-compact>.gwr-toolbar,.gwr-compact>.gwr-error,.gwr-compact>button{flex-shrink:0}.gwr-compact header{padding:14px 16px}.gwr-compact header strong{font-size:15px}.gwr-compact>button{margin:10px 14px 0;padding:7px 12px;border-radius:9px;background:var(--gwr-surface-subtle);border-color:var(--gwr-border);color:var(--gwr-accent);font-weight:600}
.gwr-task-list{overflow:auto;padding:12px 14px;min-height:0;flex:1;overscroll-behavior:contain;scrollbar-gutter:stable;background:var(--gwr-surface-subtle)}.gwr-panel .gwr-task-card{display:block;width:100%;text-align:left;padding:14px 15px;margin-bottom:10px;border-radius:12px;background:var(--gwr-surface);border:1px solid var(--gwr-border);box-shadow:var(--gwr-card-shadow)}.gwr-task-card:last-child{margin-bottom:0}.gwr-panel .gwr-task-card:hover{transform:translateY(-1px);background:var(--gwr-surface);border-color:var(--gwr-accent-border);box-shadow:0 8px 20px -6px rgba(15,23,42,.12)}.gwr-task-title{display:block;font-size:14px;font-weight:650;line-height:1.45;overflow-wrap:anywhere;color:var(--gwr-text)}.gwr-task-meta{display:flex;align-items:center;justify-content:space-between;margin:10px 0 11px;font-size:11.5px;color:var(--gwr-text-secondary);gap:8px}.gwr-task-card .gwr-steps{margin:0;gap:6px;font-size:10px}.gwr-task-card .gwr-steps span{padding:5px 2px}
.gwr-modal{position:fixed;inset:0;margin:auto;padding:0;width:min(1100px,calc(100vw - 64px));height:min(820px,calc(100vh - 64px));max-width:none;max-height:none;color:var(--gwr-text);box-sizing:border-box}.gwr-modal::backdrop{background:#11182780}
.gwr-modal>header,.gwr-modal>footer,.gwr-modal>.gwr-error{flex-shrink:0}.gwr-modal>.gwr-error{max-height:25vh;overflow:auto;overflow-wrap:anywhere}
.gwr-panel .gwr-feedback{flex-shrink:0;max-height:25vh;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;margin:10px 18px 2px;padding:11px 14px;border:1px solid var(--gwr-accent-border);border-left:3px solid var(--gwr-accent);border-radius:10px;background:var(--gwr-surface-subtle);color:var(--gwr-text);font-size:12.5px;line-height:1.6;box-shadow:var(--gwr-card-shadow)}.gwr-panel .gwr-feedback.error{border-color:#ef444455;border-left-color:#c84242;background:#ef444412;color:#b91c1c}.gwr-panel .gwr-feedback.pending{border-color:#3b82f655;border-left-color:#2563eb;background:#3b82f610}.gwr-panel .gwr-feedback.success{border-color:#10b98155;border-left-color:#10b981;background:#10b98110}
.gwr-modal .gwr-heading{min-width:0;padding-right:16px}.gwr-modal header strong{display:block;font-size:17px;overflow-wrap:anywhere}.gwr-modal header button{flex-shrink:0}.gwr-modal .gwr-content{padding:16px 26px}.gwr-modal .gwr-repo{white-space:normal;overflow-wrap:anywhere;margin:6px 0 8px;padding:6px 10px;background:var(--gwr-surface-subtle);border:1px solid var(--gwr-border);border-radius:8px}.gwr-modal .gwr-steps{margin:8px 0 12px}.gwr-modal .gwr-detail{font-size:13.5px;padding:18px 22px;margin-top:10px;background:var(--gwr-surface-subtle);border:1px solid var(--gwr-border);border-radius:12px}.gwr-modal .gwr-tabs button{font-size:13.5px}.gwr-root button:focus-visible{outline:2px solid var(--gwr-accent);outline-offset:2px}
@media(max-width:600px){.gwr-modal{width:calc(100vw - 24px);height:calc(100vh - 40px)}.gwr-modal .gwr-content{padding:12px 16px}.gwr-modal header{padding:16px}}
.gwr-root *{box-sizing:border-box}.gwr-root .gwr-modal{top:24px;bottom:90px;height:auto;max-height:820px;outline:none}.gwr-modal::backdrop{background:none}
.gwr-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.gwr-actions:empty{display:none}.gwr-content>.gwr-actions{margin:4px 0}.gwr-content details{margin:6px 0;padding:8px 12px;border:1px solid var(--gwr-border);border-radius:9px;background:var(--gwr-surface-subtle);font-size:12px}.gwr-content summary{cursor:pointer;font-weight:600;color:var(--gwr-text-secondary)}.gwr-content small[role=status]{display:inline-block;padding:5px 10px;border-radius:8px;background:var(--gwr-accent-soft);border:1px solid var(--gwr-accent-border);color:var(--gwr-accent);font-weight:600}.gwr-panel header .gwr-primary{font-size:12px;padding:6px 12px;border-radius:8px}.gwr-toolbar{padding:12px 14px 10px;border-bottom:1px solid var(--gwr-border);background:var(--gwr-surface)}.gwr-toolbar input,.gwr-form input,.gwr-form textarea{width:100%;border:1px solid var(--gwr-border-strong);background:var(--gwr-surface-subtle);color:var(--gwr-text);border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease}.gwr-toolbar input:focus,.gwr-form input:focus,.gwr-form textarea:focus{outline:none;background:var(--gwr-surface);border-color:var(--gwr-accent);box-shadow:0 0 0 3px var(--gwr-accent-soft)}.gwr-filters{display:flex;gap:4px;margin-top:9px;padding:3px;background:var(--gwr-surface-subtle);border:1px solid var(--gwr-border);border-radius:10px}.gwr-panel .gwr-filters button{flex:1;font-size:12px;padding:5px 6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--gwr-text-secondary);box-shadow:none}.gwr-panel .gwr-filters button:hover:where(:not(:disabled)){color:var(--gwr-text);background:var(--gwr-surface-hover);border-color:transparent}.gwr-panel .gwr-filters button[aria-pressed=true]{background:var(--gwr-surface);color:var(--gwr-accent);border-color:var(--gwr-accent-border);font-weight:650;box-shadow:var(--gwr-card-shadow)}.gwr-task-meta>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.gwr-compact .gwr-empty{padding:28px 24px;font-size:13px;line-height:1.7;display:flex;align-items:center;justify-content:center;min-height:0;overflow:auto}
.gwr-create>header{flex-shrink:0}.gwr-create{position:fixed;inset:24px 0 90px;margin:auto;width:min(620px,calc(100vw - 40px));height:fit-content;max-height:calc(100vh - 114px)}.gwr-form{padding:20px 22px;overflow:auto;font-size:13px}.gwr-form label{display:block;margin-bottom:16px;font-weight:600;color:var(--gwr-text)}.gwr-form input,.gwr-form textarea{display:block;margin-top:7px;resize:vertical;font-weight:400}.gwr-form>.gwr-primary{width:100%;padding:10px 16px;font-size:13.5px;border-radius:10px;margin-top:4px}.gwr-hint{font-size:12px;line-height:1.7;color:var(--gwr-text-secondary);background:var(--gwr-surface-subtle);border:1px solid var(--gwr-border);border-radius:9px;padding:9px 12px;margin:10px 0}.gwr-form .gwr-error{margin:10px 0}.gwr-panel button:disabled{opacity:.55;cursor:wait}
.gwr-workspace-manual{margin-top:12px}.gwr-project-picker{margin-bottom:18px}.gwr-project-heading,.gwr-project-selected,.gwr-project-tools{display:flex;align-items:center;justify-content:space-between;gap:10px}.gwr-project-heading{font-size:12.5px;font-weight:600;color:var(--gwr-text);margin-bottom:8px;flex-wrap:wrap}.gwr-project-heading span:last-child{font-size:11px;font-weight:500;color:var(--gwr-accent);background:var(--gwr-accent-soft);border:1px solid var(--gwr-accent-border);padding:2px 8px;border-radius:999px}.gwr-project-selected{margin-top:10px;padding:12px 14px;border:1px solid var(--gwr-accent-border);border-left:3px solid var(--gwr-accent);border-radius:10px;background:var(--gwr-accent-soft)}.gwr-project-selected>div{min-width:0}.gwr-project-selected strong{font-size:13.5px;overflow-wrap:anywhere}.gwr-project-selected small{overflow-wrap:anywhere;line-height:1.5;color:var(--gwr-text-secondary)}.gwr-project-selected>button,.gwr-project-tools>button{flex-shrink:0}.gwr-project-options{padding-top:10px}.gwr-project-tools input{margin:0;min-width:0}.gwr-project-list{max-height:180px;overflow:auto;margin-top:8px;border:1px solid var(--gwr-border);border-radius:10px;background:var(--gwr-surface-subtle);overscroll-behavior:contain}.gwr-project-list>p{padding:12px;color:var(--gwr-text-secondary);margin:0;font-size:12.5px}.gwr-panel .gwr-project-option{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--gwr-border);border-radius:0;padding:10px 13px;background:var(--gwr-surface);box-shadow:none}.gwr-project-option:last-child{border-bottom:0}.gwr-panel .gwr-project-option:hover,.gwr-panel .gwr-project-option[aria-pressed=true]{background:var(--gwr-accent-soft);border-color:var(--gwr-border)}.gwr-project-option strong{font-size:13px}.gwr-project-option small{margin-top:3px;overflow-wrap:anywhere;color:var(--gwr-text-secondary)}.gwr-project-note{font-size:11.5px;color:var(--gwr-text-secondary);line-height:1.55;margin:8px 0 0}.gwr-project-options>label{margin:10px 0 0}.gwr-task-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gwr-source{font-size:12px;overflow-wrap:anywhere}.gwr-source a{color:inherit;text-decoration:underline}
.gwr-markdown{white-space:normal;min-width:0;line-height:1.75}
.gwr-markdown>:first-child{margin-top:0}.gwr-markdown>:last-child{margin-bottom:0}
.gwr-markdown h1,.gwr-markdown h2,.gwr-markdown h3,.gwr-markdown h4,.gwr-markdown h5,.gwr-markdown h6{font-weight:650;line-height:1.45;margin:18px 0 10px;color:var(--gwr-text)}
.gwr-markdown h1{font-size:20px}.gwr-markdown h2{font-size:16.5px;border-bottom:1px solid var(--gwr-border);padding-bottom:6px}.gwr-markdown h3{font-size:14.5px}.gwr-markdown h4,.gwr-markdown h5,.gwr-markdown h6{font-size:13px}
.gwr-markdown p{margin:9px 0}.gwr-markdown strong{font-size:inherit;font-weight:700}.gwr-markdown em{font-style:italic}.gwr-markdown s{text-decoration:line-through}
.gwr-markdown ul,.gwr-markdown ol{margin:9px 0;padding-left:22px}.gwr-markdown ul{list-style:disc}.gwr-markdown ol{list-style:decimal}.gwr-markdown li{margin:4px 0}.gwr-markdown li>p{margin:4px 0}
.gwr-markdown blockquote{border-left:3px solid var(--gwr-accent);border-radius:0 8px 8px 0;margin:12px 0;padding:6px 14px;background:var(--gwr-accent-soft);color:var(--gwr-text-secondary)}
.gwr-markdown code{font:12px/1.65 Consolas,"Cascadia Code",monospace;background:var(--gwr-surface);border:1px solid var(--gwr-border);border-radius:5px;padding:1px 5px}
.gwr-markdown pre{max-width:100%;overflow-x:auto;white-space:pre;overflow-wrap:normal;margin:12px 0;padding:12px 14px;border:1px solid var(--gwr-border);border-radius:10px;background:var(--gwr-surface);box-shadow:inset 0 1px 2px rgba(15,23,42,.03)}
.gwr-markdown pre code{padding:0;border:0;background:none;white-space:pre;overflow-wrap:normal;font:12px/1.65 Consolas,"Cascadia Code",monospace;color:inherit}
.gwr-table-scroll{max-width:100%;overflow-x:auto;margin:12px 0;border:1px solid var(--gwr-border);border-radius:9px;background:var(--gwr-surface)}.gwr-markdown table{width:100%;border-collapse:collapse;font-size:12px}.gwr-markdown th,.gwr-markdown td{border-bottom:1px solid var(--gwr-border);border-right:1px solid var(--gwr-border);padding:8px 11px;text-align:left;min-width:70px}.gwr-markdown th:last-child,.gwr-markdown td:last-child{border-right:0}.gwr-markdown tr:last-child td{border-bottom:0}.gwr-markdown th{background:var(--gwr-surface-subtle);font-weight:650;color:var(--gwr-text)}.gwr-markdown tr:nth-child(even) td{background:var(--gwr-surface-subtle)}
.gwr-markdown a{color:var(--gwr-accent);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}.gwr-markdown hr{border:0;border-top:1px solid var(--gwr-border);margin:16px 0}.gwr-image-alt{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;border:1px dashed var(--gwr-border-strong);background:var(--gwr-surface);font-size:11.5px;color:var(--gwr-text-secondary)}.gwr-task-card .gwr-source{display:inline-block;margin-top:5px;padding:2px 7px;border-radius:6px;background:var(--gwr-accent-soft);color:var(--gwr-accent);font-size:11px;font-weight:500}
@media(prefers-color-scheme:dark){.gwr-markdown a{color:#5eead4}}
@media(prefers-color-scheme:dark){.gwr-root{--gwr-surface:#1e222a;--gwr-surface-subtle:#252a34;--gwr-surface-hover:#2d3340;--gwr-text:#ecf0f6;--gwr-text-secondary:#9aa5b4;--gwr-text-muted:#6e7887;--gwr-border:#313846;--gwr-border-strong:#434c5e;--gwr-accent:#2dd4bf;--gwr-accent-soft:#2dd4bf24;--gwr-accent-border:#2dd4bf59;--gwr-shadow:0 24px 60px -12px rgba(0,0,0,.65),0 6px 20px -4px rgba(0,0,0,.45);--gwr-card-shadow:0 2px 6px rgba(0,0,0,.24);color-scheme:dark}.gwr-badge{color:#fbbf24;background:#f59e0b24;border-color:#f59e0b4d}.gwr-badge.approved{color:#6ee7b7;background:#10b98124;border-color:#10b98152}.gwr-badge.running,.gwr-badge.planning,.gwr-badge.dispatching,.gwr-badge.dispatched,.gwr-badge.accepted{color:#93c5fd;background:#3b82f626;border-color:#3b82f652}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes,.gwr-error,.gwr-panel .gwr-feedback.error{color:#fca5a5}}
`;
    return { name: 'gpt-workflow-receiver', inject: ['slots', 'sessions', 'workspaces'], apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'gpt-workflow-receiver', order: 21 }, () => h(Panel, { ctx })));
    } };
  },
});
