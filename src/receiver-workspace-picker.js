import { currentDshWorkspace } from './workspace-selection.mjs';

export function createWorkspacePicker({createElement:h,useState,useEffect}) {
  return function WorkspacePicker({ctx,value,onChange,disabled}) {
    const [source,setSource]=useState(value?'manual':'auto'), [dsh,setDsh]=useState([]), [current,setCurrent]=useState(null);
    const [codex,setCodex]=useState([]), [search,setSearch]=useState(''), [loading,setLoading]=useState(false), [error,setError]=useState(''), [refresh,setRefresh]=useState(0);
    useEffect(()=>{
      if(disabled)return;
      let sessions, workspaces;
      try {sessions=ctx.sessions?.list; workspaces=ctx.workspaces?.list;} catch {return;}
      const read=()=>{
        const s=sessions?.getSnapshot(), w=workspaces?.getSnapshot();
        const active=currentDshWorkspace(s,w);
        setDsh((w?.items || []).filter(item=>typeof item.path==='string').map(item=>({id:item.workspaceId,name:item.title,path:item.path})));
        setCurrent(active || null);
        if(source==='auto')onChange(active?.path || '');
      };
      read(); const off=[sessions,workspaces].filter(store=>typeof store?.subscribe==='function').map(store=>store.subscribe(read));
      return ()=>off.forEach(fn=>fn());
    },[ctx,source,onChange,disabled]);
    useEffect(()=>{
      if(source!=='codex')return;
      let stopped=false; setLoading(true); setError('');
      (async()=>{
        try {
          const response=await fetch('/gpt-workflow-view/workspaces',{method:'POST',headers:{'X-GPT-Workflow-View':'1'},signal:AbortSignal.timeout(20000)});
          const data=await response.json();
          if(response.status===404)throw new Error('请在任务空闲时重启 DSH，加载工作区接口');
          if(!response.ok || !Array.isArray(data.workspaces))throw new Error(data.error || '无法读取 Codex 工作区');
          if(!stopped) {setCodex(data.workspaces); if(data.truncated)setError('仅显示前 500 个项目，其他工作区可手动填写路径');}
        } catch(e) {if(!stopped)setError(e.message);}
        finally {if(!stopped)setLoading(false);}
      })();
      return ()=>{stopped=true;};
    },[source,refresh]);
    const choices=(source==='codex'?codex:dsh).filter(item=>`${item.name} ${item.path}`.toLowerCase().includes(search.trim().toLowerCase()));
    return h('div',{className:'gwr-project-picker'},
      h('div',{className:'gwr-project-heading'},h('span',null,'工作区'),h('span',null,'自动识别相关仓库')),
      h('nav',{className:'gwr-filters','aria-label':'工作区来源'},[['auto','跟随 DSH'],['dsh','DSH 工作区'],['codex','Codex 工作区'],['manual','手动路径']].map(([key,label])=>h('button',{key,type:'button',disabled,'aria-pressed':source===key,onClick:()=>{setSource(key);setSearch('');setError('');onChange('');}},label))),
      source==='manual' ? h('label',{className:'gwr-workspace-manual'},'工作区路径',h('input',{value,disabled,placeholder:'例如 E:/Eworkspace',onChange:e=>onChange(e.target.value)})) :
        h('div',{className:'gwr-project-selected'},h('div',null,h('strong',null,source==='auto'?(current?.title || '未识别当前工作区'):(value?'已选择工作区':'请选择工作区')),h('small',null,value || (source==='auto'?'打开一个 DSH 工作区会话，或切换来源手动选择':'从下方选择工作区，无需指定子仓库')))),
      (source==='dsh' || source==='codex') && h('div',{className:'gwr-project-options'},
        h('div',{className:'gwr-project-tools'},h('input',{type:'search',value:search,disabled,'aria-label':'搜索工作区',placeholder:'搜索工作区名称或路径',onChange:e=>setSearch(e.target.value),onKeyDown:e=>{if(e.key==='Enter')e.preventDefault();}}),source==='codex'&&h('button',{type:'button',disabled:disabled||loading,onClick:()=>setRefresh(n=>n+1)},'刷新')),
        error&&h('p',{className:'gwr-error',role:'alert'},error),
        h('div',{className:'gwr-project-list','aria-label':'可选工作区','aria-busy':loading},loading?h('p',{role:'status'},'正在读取 Codex 工作区…'):choices.length?choices.map(item=>h('button',{key:item.path,type:'button',disabled,className:'gwr-project-option','aria-pressed':value===item.path,onClick:()=>onChange(item.path)},h('strong',null,item.name || item.path),h('small',null,item.path))):h('p',null,'没有匹配的本机工作区，可切换来源或手动填写')),
      ),
      h('p',{className:'gwr-project-note'},'填写需求后，GPT 自动定位代码及实际仓库；范围不明确时才会询问。'),
    );
  };
}
