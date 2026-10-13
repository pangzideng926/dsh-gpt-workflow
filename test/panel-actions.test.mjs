import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

test('面板按归档分组请求，加载下一页并在切换后回到首页',async()=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/receiver-panel.js',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife'});
  const slots=[],effects=[],calls=[];let index=0,plugin,component;
  const react={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),
    useState(initial){const i=index++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef(value){const i=index++;return slots[i]??=( {current:value} );},
    useMemo(fn){index++;return fn();},
    useEffect(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){old?.cleanup?.();slots[i]={deps};effects.push(()=>{slots[i].cleanup=fn();});}},
  };
  vm.runInNewContext(bundled.outputFiles[0].text,{document:new EventTarget(),CustomEvent,window:{__ModuleLoader__:{load:entry=>{plugin=entry.factory(()=>react);}}},AbortSignal,setInterval:()=>1,clearInterval(){},fetch:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    return {ok:true,json:async()=>({workspaceRequests:true,hasMore:body.view==='archived'&&body.offset===0,jobs:[{key:body.view+'-'+body.offset,title:body.view+'-'+body.offset,repo:'E:/fixture',status:'failed',...(body.view==='archived'?{archivedAt:'2026-10-13'}:{})}]})};
  }});
  plugin.apply({slots:{inject:(_,fn)=>fn(),register:(_,fn)=>{component=fn();}}});
  function render(){index=0;const tree=component.type(component.props);for(const fn of effects.splice(0))fn();return tree;}
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  function find(tree,predicate){if(!tree||typeof tree!=='object')return;return predicate(tree)?tree:tree.children?.map(child=>find(child,predicate)).find(Boolean);}
  function button(tree,text){const found=find(tree,node=>node.type==='button'&&node.children.includes(text));assert.ok(found,text);return found;}
  button(render(),'GPT').props.onClick();render();await flush();
  assert.deepEqual(calls.at(-1),{view:'active',offset:0});
  button(render(),'已归档').props.onClick();render();await flush();
  assert.deepEqual(calls.at(-1),{view:'archived',offset:0});
  button(render(),'加载更多任务').props.onClick();render();await flush();
  assert.deepEqual(calls.slice(-2),[{view:'archived',offset:0},{view:'archived',offset:100}]);
  const loaded=render();assert.ok(find(loaded,node=>node.children?.includes('archived-100')));
  assert.ok(!find(loaded,node=>node.children?.includes('加载更多任务')));
  button(loaded,'全部').props.onClick();render();await flush();
  assert.deepEqual(calls.at(-1),{view:'active',offset:0});
  for(const slot of slots)slot?.cleanup?.();
});

test('操作错误在自动刷新后仍留在当前详情，重复点击不重发',async()=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/receiver-panel.js',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife'});
  const slots=[],effects=[];let index=0,plugin,component,finish,actions=0;
  const job={key:'request:fixture',title:'独立反馈测试',repo:'E:/fixture',status:'failed',availableActions:['retry','archive'],actionVersion:'1'};
  const react={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),
    useState(initial){const i=index++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef(value){const i=index++;return slots[i]??={current:value};},useMemo(fn){index++;return fn();},
    useEffect(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){old?.cleanup?.();slots[i]={deps};effects.push(()=>{slots[i].cleanup=fn();});}},
  };
  vm.runInNewContext(bundled.outputFiles[0].text,{document:new EventTarget(),CustomEvent,window:{__ModuleLoader__:{load:entry=>plugin=entry.factory(()=>react)}},AbortSignal,setInterval:()=>1,clearInterval(){},fetch:async url=>{
    if(url.endsWith('/actions')){actions++;await new Promise(resolve=>finish=resolve);return {ok:false,json:async()=>({error:'GPT 会话尚未确认释放，请先异常恢复'})};}
    return {ok:true,json:async()=>({workspaceRequests:true,jobs:[job]})};
  }});
  plugin.apply({slots:{inject:(_,fn)=>fn(),register:(_,fn)=>component=fn()}});
  function render(){index=0;const tree=component.type(component.props);for(const fn of effects.splice(0))fn();return tree;}
  function find(n,p){if(!n||typeof n!=='object')return;return p(n)?n:n.children?.map(c=>find(c,p)).find(Boolean);}
  const details=tree=>find(tree,n=>typeof n.props.onAction==='function'&&n.props.job?.key===job.key);
  const flush=()=>new Promise(r=>setImmediate(r));
  find(render(),n=>n.props.className==='gwr-launcher').props.onClick();render();await flush();
  find(render(),n=>n.props.className==='gwr-task-card').props.onClick();
  const current=details(render()),pending=current.props.onAction('retry');
  await current.props.onAction('retry');assert.equal(actions,1);
  assert.equal(details(render()).props.actionBusy,true);
  finish();await pending;render();await flush();
  const refreshed=details(render());
  assert.match(refreshed.props.feedback?.text || refreshed.props.error || '',/GPT 会话尚未确认释放/);
  assert.equal(refreshed.props.actionBusy,false);
  for(const slot of slots)slot?.cleanup?.();
});
