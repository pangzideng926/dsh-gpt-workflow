import { renderMarkdown } from './receiver-markdown.mjs';
import { createWorkspacePicker } from './receiver-workspace-picker.js';

// DSH 客户端模块入口：由宿主提供 React 和原生会话导航。
window.__ModuleLoader__.load({
  id: 'dsh-gpt-receiver',
  factory: require => {
    const { createElement: h, useState, useEffect, useMemo, useRef } = require('react');
    const labels = { planning: 'GPT 规划中', needs_input: '待补充需求', dispatching: '正在派发', dispatched: '已派发 DSH', accepted: '已接收', running: '开发中', completed: '待 GPT 审查', failed: '执行失败', interrupted: '需要核查', approved: '审查通过', needs_changes: '需要返工' };
    const status = job => job.review?.verdict || job.status;
    const round = job => job.key.startsWith('request:') ? '新需求' : `第 ${job.key.split('-').at(-1)} 轮`;
    const active = job => ['planning', 'dispatching', 'dispatched', 'accepted', 'running'].includes(status(job));
    function Steps({ job }) {
      const current = status(job);
      return h('div', { className: 'gwr-steps', 'aria-label': '协作进度' }, ['GPT 方案', 'DSH 开发', 'GPT 审查'].map((text, index) => h('span', { key: text, className: (index === 0 && !!job.plan || index === 1 && ['completed','approved','needs_changes'].includes(current) || index === 2 && !!job.review) ? 'done' : '' }, `${index + 1}  ${text}`)));
    }
    function Details({ job, error, onClose, onOpenSession, onOpenGpt, onReuse }) {
      const dialog = useRef(null);
      const [tab, setTab] = useState('plan');
      const [copied, setCopied] = useState('');
      useEffect(() => { dialog.current.focus({ preventScroll: true }); }, []);
      const body = tab === 'plan' ? job.plan || (job.requirement ? `## 用户需求\n${job.requirement}\n\n## 当前状态\n${job.error || labels[status(job)]}` : '历史任务未保存方案副本，请打开开发会话查看。') : tab === 'answer' ? job.answer || job.error || '开发完成后会在这里显示结果。' : job.review?.summary || '等待 GPT 核对代码与测试证据，DSH 完成不等于审查通过。';
      const renderedBody = useMemo(() => renderMarkdown(body), [body]);
      const current = status(job);
      return h('section', { ref: dialog, tabIndex: -1, role: 'dialog', 'aria-modal': false, className: 'gwr-panel gwr-modal', 'aria-label': `任务详情：${job.title}`, onKeyDown: e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
        h('header', null, h('div', { className: 'gwr-heading' }, h('strong', null, job.title), h('small', null, `${round(job)} · 任务详情`)), h('button', { onClick: onClose, 'aria-label': '关闭任务详情' }, '×')),
        error && h('p', { className: 'gwr-error', role: 'alert' }, error),
        h('div', { className: 'gwr-content' },
          h('div', { className: 'gwr-job' }, h('span', { className: `gwr-badge ${current}` }, labels[current] || current), h('div', {className:'gwr-actions'}, job.gptThreadId && h('button', {className:'gwr-primary',onClick:onOpenGpt}, '打开 GPT 会话'), job.sessionId && h('button', { onClick: onOpenSession }, '打开开发会话'))),
          h('p', { className: 'gwr-repo' }, job.repo),
          h('div', { className: 'gwr-actions' }, job.requirement && h('button', { onClick: onReuse }, '复用需求新建'), job.sessionId && current === 'completed' && h('button', { onClick: async () => { try { await navigator.clipboard.writeText(`请使用 dsh-gpt-workflow 审查任务 ${job.key.replace(/-\d+$/, '')}，仓库 ${job.repo}。先读取 workflow_result 中的 diff、新文件和测试证据，再提交 GPT 审查结论。`); const opened = job.gptThreadId ? await onOpenGpt() : false; setCopied(opened ? '已复制并打开原 GPT 会话，粘贴发送即可审查' : '已复制，粘贴到 Codex 即可审查'); } catch { setCopied('复制失败，请在 Codex 中按任务名称继续审查'); } } }, job.gptThreadId ? '复制审查指令并打开 GPT' : '复制 GPT 审查指令')),
          copied && h('small', { role: 'status' }, copied),
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
            const response = await fetch('/gpt-workflow-view', { method: 'POST', headers: { 'X-GPT-Workflow-View': '1' }, signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`接收插件暂不可用（${response.status}）`);
            const data = await response.json();
            if (!Array.isArray(data.jobs)) throw new Error('任务列表响应无效，请检查接收插件版本');
            if (!stopped) { setJobs(data.jobs); setWorkspaceReady(data.workspaceRequests === true); setError(''); setLoading(false); }
          } catch (e) { if (!stopped) { setError(e.message); setLoading(false); } }
          finally { busy = false; }
        };
        void refresh(); const timer = setInterval(refresh, 2500);
        return () => { stopped = true; clearInterval(timer); };
      }, [open]);
      const job = jobs.find(j => j.key === selected);
      const openGpt = async () => {
        try {
          const response=await fetch('/gpt-workflow-view/open-gpt',{method:'POST',headers:{'X-GPT-Workflow-View':'1','Content-Type':'application/json'},body:JSON.stringify({key:job.key}),signal:AbortSignal.timeout(20000)});
          const data=await response.json(); if (!response.ok) throw new Error(data.error || '无法打开 Codex');
          setError(''); return true;
        } catch(e) {setError(`打开 GPT 会话失败：${e.message}。请确认 Codex 桌面版已安装。`); return false;}
      };
      const visible = jobs.filter(j => (!query || `${j.title} ${j.repo}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'active' && active(j) || filter === 'review' && status(j) === 'completed')).sort((a, b) => Number(active(b)) - Number(active(a)));
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
          error && h('p', { className: 'gwr-error', role: 'alert' }, error),
          h('div', { className: 'gwr-toolbar' }, h('input', { type: 'search', placeholder: '搜索任务或仓库', 'aria-label': '搜索任务或仓库', value: query, onChange: e => setQuery(e.target.value) }), h('nav', { className: 'gwr-filters', 'aria-label': '任务筛选' }, [['all','全部'],['active','进行中'],['review','待审查']].map(([key, title]) => h('button', { key, 'aria-pressed': filter === key, onClick: () => setFilter(key) }, title)))),
          !visible.length ? h('div', { className: 'gwr-empty' }, loading ? '正在加载任务…' : jobs.length ? '没有匹配任务' : '点击「新建」填写需求，交给 GPT 规划') : h('div', { className: 'gwr-task-list' }, visible.map(j => h('button', { key: j.key, className: 'gwr-task-card', onClick: () => { setCreating(false); select(j.key); }, 'aria-label': `查看任务：${j.title}，${round(j)}，${labels[status(j)] || status(j)}` },
            h('span', { className: 'gwr-task-title' }, j.title),
            h('span', { className: 'gwr-task-meta' }, h('span', { title: j.repo }, `${j.repo.split(/[\\/]/).at(-1)} · ${round(j)}`), h('span', { className: `gwr-badge ${status(j)}` }, labels[status(j)] || status(j))),
            h(Steps, { job: j }),
          ))),
        ),
        open && job && h(Details, { key: job.key, job, error, onClose: () => select(''), onOpenSession: openSession, onOpenGpt:openGpt, onReuse: () => { setWorkspace(job.workspace || job.repo); setRequirement(job.requirement); setFormError(''); select(''); setCreating(true); } }),
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
.gwr-root{position:fixed;inset:0;pointer-events:none;z-index:45;font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",sans-serif);color:var(--dsw-alias-label-primary-foreground,#20252d)}
.gwr-launcher{position:absolute;right:78px;bottom:18px;width:48px;height:48px;border-radius:50%;border:1px solid #aaa5;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;box-shadow:0 4px 18px #0002;font-size:13px;font-weight:700;cursor:pointer;pointer-events:auto}
.gwr-panel{position:absolute;right:18px;bottom:78px;width:460px;max-width:calc(100vw - 36px);height:610px;max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid #9994;border-radius:16px;box-shadow:0 18px 70px #0003;pointer-events:auto;overflow:hidden}
.gwr-panel header{padding:20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #8882}.gwr-panel strong{font-size:17px}.gwr-panel small{display:block;font-size:12px;opacity:.65;margin-top:6px}.gwr-panel button{font:inherit;color:inherit;cursor:pointer;border:1px solid #8883;background:transparent;border-radius:7px;padding:7px 11px}.gwr-panel header button{font-size:22px;padding:1px 8px;border:0}.gwr-content{padding:16px 20px;min-height:0;flex:1;display:flex;flex-direction:column}.gwr-label{font-size:12px;opacity:.85}.gwr-label select{display:block;width:100%;padding:9px;margin:6px 0 14px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;border:1px solid #8884;border-radius:8px;font:inherit;font-size:13px}.gwr-job{display:flex;align-items:center;justify-content:space-between;gap:8px}.gwr-badge{padding:5px 9px;border-radius:6px;background:#f2b54420;color:#a36610;font-size:12px}.gwr-badge.running{background:#3b82f620;color:#3976da}.gwr-badge.approved{background:#10b98120;color:#159168}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes{background:#ef444420;color:#c84242}.gwr-panel .gwr-primary{background:#236c5f;color:white;border:0;font-size:12px}.gwr-repo{font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:10px 0 16px}.gwr-steps{display:flex;gap:8px;font-size:11px;margin-bottom:18px}.gwr-steps span{flex:1;padding:8px 3px;text-align:center;border-bottom:2px solid #8883;opacity:.55}.gwr-steps .done{border-color:#269781;opacity:1}.gwr-tabs{display:flex;border-bottom:1px solid #8883;gap:8px}.gwr-panel .gwr-tabs button{border:0;border-radius:0;font-size:12px;padding:8px 10px}.gwr-panel .gwr-tabs .active{border-bottom:2px solid #269781;font-weight:600}.gwr-detail{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;flex:1;overflow:auto;margin:0;padding:14px 0;min-height:100px}.gwr-panel footer{display:flex;justify-content:space-between;padding:12px 20px;border-top:1px solid #8882;font-size:10px;opacity:.6}.gwr-error{background:#ef444418;color:#c84242;margin:10px 20px;padding:10px;border-radius:6px;font-size:12px}.gwr-empty{padding:50px 30px;text-align:center;flex:1}.gwr-empty p{font-size:13px;line-height:1.8;opacity:.6}.gwr-panel button:hover{filter:brightness(.92)}
.gwr-root{--gwr-surface:#ffffff;--gwr-text:#20252d;color:var(--gwr-text);color-scheme:light}
.gwr-panel,.gwr-launcher,.gwr-label select{background:var(--gwr-surface);color:var(--gwr-text)}
.gwr-compact{width:360px;height:720px;max-height:calc(100vh - 110px)}.gwr-compact>header,.gwr-compact>.gwr-toolbar,.gwr-compact>.gwr-error{flex-shrink:0}.gwr-compact header{padding:14px 16px}.gwr-compact header strong{font-size:15px}
.gwr-task-list{overflow:auto;padding:12px;min-height:0;flex:1;overscroll-behavior:contain;scrollbar-gutter:stable}.gwr-panel .gwr-task-card{display:block;width:100%;text-align:left;padding:14px;margin-bottom:10px;border-radius:10px}.gwr-task-card:last-child{margin-bottom:0}.gwr-task-card:hover{background:#8881}.gwr-task-title{display:block;font-size:14px;font-weight:650;overflow-wrap:anywhere}.gwr-task-meta{display:flex;align-items:center;justify-content:space-between;margin:10px 0;font-size:11px;gap:8px}.gwr-task-card .gwr-steps{margin:0;gap:6px;font-size:10px}.gwr-task-card .gwr-steps span{padding:5px 0}
.gwr-modal{position:fixed;inset:0;margin:auto;padding:0;width:min(1100px,calc(100vw - 64px));height:min(820px,calc(100vh - 64px));max-width:none;max-height:none;color:var(--gwr-text);box-sizing:border-box}.gwr-modal::backdrop{background:#11182780}.gwr-modal .gwr-heading{min-width:0;padding-right:16px}.gwr-modal header strong{display:block;overflow-wrap:anywhere}.gwr-modal header button{flex-shrink:0}.gwr-modal .gwr-content{padding:16px 28px}.gwr-modal .gwr-repo{white-space:normal;overflow-wrap:anywhere;margin:10px 0}.gwr-modal .gwr-steps{margin-bottom:10px}.gwr-modal .gwr-detail{font-size:14px;padding:20px 4px}.gwr-modal .gwr-tabs button{font-size:14px}.gwr-root button:focus-visible{outline:2px solid #269781;outline-offset:2px}
@media(max-width:600px){.gwr-modal{width:calc(100vw - 24px);height:calc(100vh - 40px)}.gwr-modal .gwr-content{padding:12px 16px}.gwr-modal header{padding:16px}}
.gwr-root *{box-sizing:border-box}.gwr-root .gwr-modal{top:24px;bottom:90px;height:auto;max-height:820px;outline:none}.gwr-modal::backdrop{background:none}
.gwr-actions{display:flex;align-items:center;gap:6px}.gwr-panel header .gwr-primary{font-size:12px;padding:7px 10px;border-radius:7px}.gwr-toolbar{padding:12px 12px 0}.gwr-toolbar input,.gwr-form input,.gwr-form textarea{width:100%;border:1px solid #8885;background:var(--gwr-surface);color:var(--gwr-text);border-radius:7px;padding:9px;font:inherit;font-size:13px}.gwr-filters{display:flex;gap:6px;margin-top:8px}.gwr-filters button{flex:1;font-size:12px}.gwr-filters button[aria-pressed=true]{background:#26978120;border-color:#269781}.gwr-task-meta>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.gwr-badge{flex-shrink:0}.gwr-compact .gwr-empty{padding:24px;font-size:13px;line-height:1.7;display:flex;align-items:center;justify-content:center;min-height:0;overflow:auto}
.gwr-create>header{flex-shrink:0}.gwr-create{position:fixed;inset:24px 0 90px;margin:auto;width:min(620px,calc(100vw - 40px));height:fit-content;max-height:calc(100vh - 114px)}.gwr-form{padding:20px;overflow:auto;font-size:13px}.gwr-form label{display:block;margin-bottom:16px}.gwr-form input,.gwr-form textarea{display:block;margin-top:6px;resize:vertical}.gwr-hint{font-size:12px;line-height:1.7;opacity:.7;margin:12px 0}.gwr-form .gwr-error{margin:10px 0}.gwr-panel button:disabled{opacity:.6;cursor:wait}.gwr-badge.planning,.gwr-badge.dispatching{color:#3976da;background:#3b82f620}
.gwr-workspace-manual{margin-top:12px}.gwr-project-picker{margin-bottom:18px}.gwr-project-heading,.gwr-project-selected,.gwr-project-tools{display:flex;align-items:center;justify-content:space-between;gap:10px}.gwr-project-heading{font-size:12px;opacity:.7;margin-bottom:8px;flex-wrap:wrap}.gwr-project-selected{margin-top:10px;padding:12px;border:1px solid #26978166;border-radius:9px;background:#2697810a}.gwr-project-selected>div{min-width:0}.gwr-project-selected strong{font-size:14px;overflow-wrap:anywhere}.gwr-project-selected small{overflow-wrap:anywhere;line-height:1.5;opacity:.8}.gwr-project-selected>button,.gwr-project-tools>button{flex-shrink:0}.gwr-project-options{padding-top:10px}.gwr-project-tools input{margin:0;min-width:0}.gwr-project-list{max-height:180px;overflow:auto;margin-top:8px;border:1px solid #8883;border-radius:8px;overscroll-behavior:contain}.gwr-project-list>p{padding:10px;color:var(--gwr-text)}.gwr-panel .gwr-project-option{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #8882;border-radius:0;padding:9px 12px}.gwr-project-option:last-child{border-bottom:0}.gwr-project-option:hover,.gwr-project-option[aria-pressed=true]{background:#26978118}.gwr-project-option strong{font-size:13px}.gwr-project-option small{margin-top:3px;overflow-wrap:anywhere;opacity:.75}.gwr-project-note{font-size:11px;opacity:.7;line-height:1.5}.gwr-project-options>label{margin:10px 0 0}.gwr-task-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gwr-markdown{white-space:normal;min-width:0;line-height:1.75}
.gwr-markdown>:first-child{margin-top:0}.gwr-markdown>:last-child{margin-bottom:0}
.gwr-markdown h1,.gwr-markdown h2,.gwr-markdown h3,.gwr-markdown h4,.gwr-markdown h5,.gwr-markdown h6{font-weight:650;line-height:1.45;margin:18px 0 10px}
.gwr-markdown h1{font-size:20px}.gwr-markdown h2{font-size:17px;border-bottom:1px solid #8883;padding-bottom:6px}.gwr-markdown h3{font-size:15px}.gwr-markdown h4,.gwr-markdown h5,.gwr-markdown h6{font-size:13px}
.gwr-markdown p{margin:9px 0}.gwr-markdown strong{font-size:inherit;font-weight:700}.gwr-markdown em{font-style:italic}.gwr-markdown s{ text-decoration:line-through }
.gwr-markdown ul,.gwr-markdown ol{margin:9px 0;padding-left:24px}.gwr-markdown ul{list-style:disc}.gwr-markdown ol{list-style:decimal}.gwr-markdown li{margin:4px 0}.gwr-markdown li>p{margin:4px 0}
.gwr-markdown blockquote{border-left:3px solid #269781;margin:12px 0;padding:2px 12px;background:#8881}
.gwr-markdown code{font:12px/1.65 Consolas,"Cascadia Code",monospace;background:#8882;border-radius:4px;padding:2px 4px}
.gwr-markdown pre{max-width:100%;overflow-x:auto;white-space:pre;overflow-wrap:normal;margin:12px 0;padding:12px;border:1px solid #8883;border-radius:8px;background:#8881}
.gwr-markdown pre code{padding:0;border:0;background:none;white-space:pre;overflow-wrap:normal;font:12px/1.65 Consolas,"Cascadia Code",monospace;color:inherit}
.gwr-table-scroll{max-width:100%;overflow-x:auto;margin:12px 0}.gwr-markdown table{width:100%;border-collapse:collapse;font-size:12px}.gwr-markdown th,.gwr-markdown td{border:1px solid #8884;padding:7px 10px;text-align:left;min-width:70px}.gwr-markdown th{background:#8882;font-weight:650}.gwr-markdown tr:nth-child(even){background:#8881}
.gwr-markdown a{color:#218573;text-decoration:underline;overflow-wrap:anywhere}.gwr-markdown hr{border:0;border-top:1px solid #8884;margin:16px 0}
@media(prefers-color-scheme:dark){.gwr-markdown a{color:#64d8af}}
@media(prefers-color-scheme:dark){.gwr-root{--gwr-surface:#24272d;--gwr-text:#edf0f5;color-scheme:dark}.gwr-badge{color:#e7b657}.gwr-badge.approved{color:#64d8af}.gwr-badge.running{color:#88b7ff}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes,.gwr-error{color:#ff9c9c}}
`;
    return { name: 'gpt-workflow-receiver', inject: ['slots', 'sessions', 'workspaces'], apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'gpt-workflow-receiver', order: 21 }, () => h(Panel, { ctx })));
    } };
  },
});
