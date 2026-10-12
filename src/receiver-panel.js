// DSH 客户端模块入口：由宿主提供 React 和原生会话导航。
window.__ModuleLoader__.load({
  id: 'dsh-gpt-receiver',
  factory: require => {
    const { createElement: h, useState, useEffect } = require('react');
    const labels = { accepted: '已接收', running: '开发中', completed: '待 GPT 审查', failed: '执行失败', interrupted: '需要核查', approved: '审查通过', needs_changes: '需要返工' };
    const status = job => job.review?.verdict || job.status;
    function Panel({ ctx }) {
      const [open, setOpen] = useState(false), [jobs, setJobs] = useState([]), [selected, select] = useState(''), [tab, setTab] = useState('plan'), [error, setError] = useState(''), [updated, setUpdated] = useState('');
      useEffect(() => {
        if (!open) return;
        let stopped = false, busy = false;
        const refresh = async () => {
          if (busy) return; busy = true;
          try {
            const response = await fetch('/gpt-workflow-view', { method: 'POST', headers: { 'X-GPT-Workflow-View': '1' }, signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`接收插件暂不可用（${response.status}）`);
            const data = await response.json();
            if (!stopped) { setJobs(data.jobs); setError(''); setUpdated(new Date().toLocaleTimeString()); }
          } catch (e) { if (!stopped) setError(e.message); }
          finally { busy = false; }
        };
        void refresh(); const timer = setInterval(refresh, 2500);
        return () => { stopped = true; clearInterval(timer); };
      }, [open]);
      const job = jobs.find(j => j.key === selected) || jobs[0];
      const openSession = async () => {
        try {
          const ui = ctx.get('uiWorkspace');
          if (!ui?.openSession) throw new Error('会话导航尚未就绪，请从左侧工作区打开该会话');
          await ui.openSession(job.sessionId); setOpen(false);
        } catch (e) { setError(e.message); }
      };
      const current = job ? status(job) : '';
      const body = !job ? '' : tab === 'plan' ? job.plan || '历史任务未保存方案副本，请打开开发会话查看。' : tab === 'answer' ? job.answer || job.error || 'DSH 正在开发，完成后会在这里显示结果。' : job.review?.summary || '等待 GPT 核对代码与测试证据，DSH 完成不等于审查通过。';
      return h('div', { className: 'gwr-root' },
        h('button', { className: 'gwr-launcher', title: 'GPT 协作工作台', 'aria-label': 'GPT 协作工作台', onClick: () => setOpen(!open) }, 'GPT'),
        open && h('section', { className: 'gwr-panel', role: 'dialog', 'aria-label': 'GPT 协作工作台' },
          h('header', null, h('div', null, h('strong', null, 'GPT 协作工作台'), h('small', null, '实施方案 → DSH 开发 → GPT 审查')), h('button', { onClick: () => setOpen(false), 'aria-label': '收起 GPT 工作台' }, '×')),
          error && h('p', { className: 'gwr-error', role: 'alert' }, error),
          !jobs.length ? h('div', { className: 'gwr-empty' }, h('strong', null, '等待 GPT 派发任务'), h('p', null, '在 Codex 中说明需求，GPT 生成实施方案后会自动发送到这里。')) : h('div', { className: 'gwr-content' },
            h('label', { className: 'gwr-label' }, '任务', h('select', { value: job.key, onChange: e => { select(e.target.value); setTab('plan'); } }, jobs.map(j => h('option', { key: j.key, value: j.key }, `${j.title} · 第 ${j.key.split('-').at(-1)} 轮`)))),
            h('div', { className: 'gwr-job' }, h('span', { className: `gwr-badge ${current}` }, labels[current] || current), h('button', { className: 'gwr-primary', onClick: openSession }, '打开开发会话')),
            h('p', { className: 'gwr-repo', title: job.repo }, job.repo),
            h('div', { className: 'gwr-steps', 'aria-label': '协作进度' }, ['GPT 方案', 'DSH 开发', 'GPT 审查'].map((text, index) => h('span', { key: text, className: (index === 0 || index === 1 && ['completed','approved','needs_changes'].includes(current) || index === 2 && !!job.review) ? 'done' : '' }, `${index + 1}  ${text}`))),
            h('nav', { className: 'gwr-tabs', 'aria-label': '任务详情' }, [['plan', '实施方案'], ['answer', '开发结果'], ['review', 'GPT 审查']].map(([key, title]) => h('button', { key, onClick: () => setTab(key), 'aria-pressed': tab === key, className: tab === key ? 'active' : '' }, title))),
            h('pre', { className: 'gwr-detail' }, body),
            job.permissionPreset && h('small', { className: 'gwr-permission' }, `完成时访问模式：${job.permissionPreset}`),
          ),
          h('footer', null, h('span', null, '仅由 GPT 提交审查结论'), h('span', null, updated ? `更新于 ${updated}` : '正在连接…')),
        ));
    }
    // 工作台使用成对的自有前景/背景色，避免宿主按钮 foreground（白色）
    // 与宿主面板背景（白色）混用，导致浅色主题文字全部不可见。
    const css = `
.gwr-root{position:absolute;inset:0;pointer-events:none;z-index:45;font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",sans-serif);color:var(--dsw-alias-label-primary-foreground,#20252d)}
.gwr-launcher{position:absolute;right:78px;bottom:18px;width:48px;height:48px;border-radius:50%;border:1px solid #aaa5;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;box-shadow:0 4px 18px #0002;font-size:13px;font-weight:700;cursor:pointer;pointer-events:auto}
.gwr-panel{position:absolute;right:18px;bottom:78px;width:460px;max-width:calc(100vw - 36px);height:610px;max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid #9994;border-radius:16px;box-shadow:0 18px 70px #0003;pointer-events:auto;overflow:hidden}
.gwr-panel header{padding:20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #8882}.gwr-panel strong{font-size:17px}.gwr-panel small{display:block;font-size:12px;opacity:.65;margin-top:6px}.gwr-panel button{font:inherit;color:inherit;cursor:pointer;border:1px solid #8883;background:transparent;border-radius:7px;padding:7px 11px}.gwr-panel header button{font-size:22px;padding:1px 8px;border:0}.gwr-content{padding:16px 20px;min-height:0;flex:1;display:flex;flex-direction:column}.gwr-label{font-size:12px;opacity:.85}.gwr-label select{display:block;width:100%;padding:9px;margin:6px 0 14px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;border:1px solid #8884;border-radius:8px;font:inherit;font-size:13px}.gwr-job{display:flex;align-items:center;justify-content:space-between;gap:8px}.gwr-badge{padding:5px 9px;border-radius:6px;background:#f2b54420;color:#a36610;font-size:12px}.gwr-badge.running{background:#3b82f620;color:#3976da}.gwr-badge.approved{background:#10b98120;color:#159168}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes{background:#ef444420;color:#c84242}.gwr-panel .gwr-primary{background:#236c5f;color:white;border:0;font-size:12px}.gwr-repo{font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:10px 0 16px}.gwr-steps{display:flex;gap:8px;font-size:11px;margin-bottom:18px}.gwr-steps span{flex:1;padding:8px 3px;text-align:center;border-bottom:2px solid #8883;opacity:.55}.gwr-steps .done{border-color:#269781;opacity:1}.gwr-tabs{display:flex;border-bottom:1px solid #8883;gap:8px}.gwr-panel .gwr-tabs button{border:0;border-radius:0;font-size:12px;padding:8px 10px}.gwr-panel .gwr-tabs .active{border-bottom:2px solid #269781;font-weight:600}.gwr-detail{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;flex:1;overflow:auto;margin:0;padding:14px 0;min-height:100px}.gwr-panel footer{display:flex;justify-content:space-between;padding:12px 20px;border-top:1px solid #8882;font-size:10px;opacity:.6}.gwr-error{background:#ef444418;color:#c84242;margin:10px 20px;padding:10px;border-radius:6px;font-size:12px}.gwr-empty{padding:50px 30px;text-align:center;flex:1}.gwr-empty p{font-size:13px;line-height:1.8;opacity:.6}.gwr-panel button:hover{filter:brightness(.92)}
.gwr-root{--gwr-surface:#ffffff;--gwr-text:#20252d;color:var(--gwr-text);color-scheme:light}
.gwr-panel,.gwr-launcher,.gwr-label select{background:var(--gwr-surface);color:var(--gwr-text)}
@media(prefers-color-scheme:dark){.gwr-root{--gwr-surface:#24272d;--gwr-text:#edf0f5;color-scheme:dark}.gwr-badge{color:#e7b657}.gwr-badge.approved{color:#64d8af}.gwr-badge.running{color:#88b7ff}.gwr-badge.failed,.gwr-badge.interrupted,.gwr-badge.needs_changes,.gwr-error{color:#ff9c9c}}
`;
    return { name: 'gpt-workflow-receiver', inject: ['slots', 'sessions'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove(); }, 'gpt-workflow-panel: styles');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'gpt-workflow-receiver', order: 21 }, () => h(Panel, { ctx })));
    } };
  },
});
