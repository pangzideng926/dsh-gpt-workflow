import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Workflow} from '../src/workflow.mjs';
import {QuickRequests} from '../src/quick-requests.mjs';
import {TaskActions} from '../src/task-actions.mjs';
const plan='## 目标与范围\n文档\n## 代码依据\nREADME.md\n## 实施步骤\n修正文档\n## 验收标准\nA1 正确\n## 测试要求\n检查';
function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-actions-')),repo=path.join(home,'repo');fs.mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',windowsHide:true});
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'README.md'),'fixture');git('add','.');git('commit','-m','初始化');
  const workflow=new Workflow({home:path.join(home,'workflow')}); workflow.start=async()=>{throw new Error('测试禁止实际派发');};
  const requests=new QuickRequests(path.join(home,'requests'),{workflow,plan:async(item,update)=>{update({gptSessionState:'released'});throw new Error('规划离线');}});
  const store={active:new Map(),list:()=>[]};
  const actions=new TaskActions(requests,store);
  const input={id:randomUUID(),repo,requirement:'文档修复'};
  const run=(key,action)=>actions.perform({key,action,version:actions.describe(key).actionVersion});
  return {home,repo,workflow,requests,store,actions,input,run};
}
async function failed(f){const item=await f.requests.accept(f.input);await f.requests.active.get(item.id);return f.requests.get(item.id);}
test('规划失败重试沿用原 ID，保留历史，重复请求不再次规划',async()=>{
  const f=fixture(),item=await failed(f);let calls=0,release;
  f.requests.plan=async(_item,update)=>{calls++;await new Promise(r=>release=r);update({gptSessionState:'released'});return {status:'needs_input',questions:'补充范围'};};
  const version=f.actions.describe(item.key).actionVersion;
  await f.actions.perform({key:item.key,action:'retry',version});
  await assert.rejects(f.actions.perform({key:item.key,action:'retry',version}),/变化|执行|规划/);
  assert.equal(calls,1);assert.equal(f.requests.get(item.id).generation,2);
  assert.equal(f.requests.get(item.id).history[0].error,'规划离线');
  release();await f.requests.active.get(item.id);assert.equal(f.requests.get(item.id).status,'needs_input');
});
test('运行中与未知 GPT 占用禁止归档重试；有退出证据才恢复',async()=>{
  const f=fixture(),item=await failed(f);
  f.requests.save({...item,status:'interrupted',gptSessionState:'owned',gptPid:process.pid});
  for(const action of ['recover','retry','archive'])await assert.rejects(f.run(item.key,action),/GPT|规划/);
  f.requests.save({...f.requests.get(item.id),gptPid:undefined});
  await assert.rejects(f.run(item.key,'recover'),/证明/);
  f.requests.save({...f.requests.get(item.id),gptSessionState:'released'});
  await f.run(item.key,'recover');assert.equal(f.requests.get(item.id).status,'failed');
});
test('归档保留数据和禅道来源；恢复显示不派发',async()=>{
  const f=fixture();const source={provider:'zentao',server:'https://example.invalid',kind:'task',id:'42'};
  const item=await f.requests.accept({workspace:f.repo,requirement:'原需求',source});await f.requests.active.get(item.id);
  await f.run(item.key,'archive');assert.ok(f.requests.get(item.id).archivedAt);
  assert.equal((await f.requests.accept({workspace:f.repo,requirement:'变化的需求',source})).id,item.id);
  await f.run(item.key,'restore');assert.equal(f.requests.get(item.id).archivedAt,undefined);
  assert.equal(f.requests.get(item.id).requirement,'原需求');assert.equal(f.requests.active.size,0);
});
test('开发失败保留旧证据，重试原任务新轮次；旧面板版本拒绝操作',async()=>{
  const f=fixture(),item=await failed(f);const task=f.workflow.load((await f.workflow.create({repo:f.repo,title:'开发',plan})).id);
  task.status='failed';task.attempt=1;task.runDir=path.join(f.workflow.dir(task.id),'runs','1');fs.mkdirSync(task.runDir,{recursive:true});
  f.workflow.finish(task,{exitCode:1,error:'测试失败',answer:'失败报告'});
  f.requests.save({...item,status:'dispatched',taskId:task.id});
  const before=fs.readFileSync(path.join(task.runDir,'evidence.json'),'utf8');let starts=0;
  f.workflow.start=async id=>{const t=f.workflow.load(id);assert.equal(t.status,'planned');starts++;t.attempt++;t.status='running';f.workflow.save(t);};
  const version=f.actions.describe(item.key).actionVersion;
  await f.actions.perform({key:item.key,action:'retry',version});assert.equal(starts,1);
  assert.equal(f.workflow.load(task.id).attempt,2);assert.equal(fs.readFileSync(path.join(task.runDir,'evidence.json'),'utf8'),before);
  await assert.rejects(f.actions.perform({key:item.key,action:'retry',version}),/变化|运行/);
});
test('代码变化、活跃接收轮次和多仓库部分占用都阻止重派',async()=>{
  const f=fixture(),item=await failed(f);const task=f.workflow.load((await f.workflow.create({repo:f.repo,title:'开发',plan})).id);
  f.requests.save({...item,taskId:task.id});
  f.store.active.set(`${task.id}-0`,Promise.resolve());await assert.rejects(f.run(item.key,'retry'),/DSH/);f.store.active.clear();
  fs.writeFileSync(path.join(f.repo,'README.md'),'other change');
  await assert.rejects(f.run(item.key,'retry'),/基线/);assert.equal(f.workflow.load(task.id).status,'planned');
  const request=f.requests.get(item.id);request.taskIds=[task.id,randomUUID()];f.requests.save(request);
  await assert.rejects(f.run(item.key,'archive'));assert.equal(f.requests.get(item.id).archivedAt,undefined);
});

test('恢复后重试仍保留原始规划失败原因',async()=>{
  const f=fixture(),item=await failed(f);
  await f.run(item.key,'recover');await f.run(item.key,'retry');await f.requests.active.get(item.id);
  assert.equal(f.requests.get(item.id).history[0].error,'规划离线');
});

test('DSH 改变提交或分支造成的失败不得被重试接管',async()=>{
  for(const change of ['commit','branch']){
    const f=fixture(),item=await failed(f),task=f.workflow.load((await f.workflow.create({repo:f.repo,title:'开发',plan})).id);
    task.attempt=1;task.runDir=path.join(f.workflow.dir(task.id),'runs','1');fs.mkdirSync(task.runDir,{recursive:true});
    const git=(...args)=>execFileSync('git',['-C',f.repo,...args],{stdio:'pipe',windowsHide:true});
    if(change==='commit'){fs.writeFileSync(path.join(f.repo,'README.md'),'committed');git('add','.');git('commit','-m','模拟异常提交');}else git('switch','-c','unexpected');
    f.workflow.finish(task,{exitCode:0,answer:'错误地报告成功'});f.requests.save({...item,taskId:task.id});
    await assert.rejects(f.run(item.key,'retry'),/提交|分支|人工核查/);
    assert.equal(f.workflow.load(task.id).baseline.head,task.baseline.head);
  }
});

test('任务操作接口拒绝跨站、过期状态和超长请求；归档仍可恢复显示',async()=>{
  const {default:http}=await import('node:http');const {panelHandler}=await import('../src/panel-api.mjs');
  const f=fixture(),item=await failed(f),server=http.createServer(panelHandler(f.store,f.requests));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/gpt-workflow-view`;
  const send=(url,body={},headers={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-GPT-Workflow-View':'1',...headers},body:JSON.stringify(body)});
  try{
    const body={key:item.key,action:'archive',version:f.actions.describe(item.key).actionVersion};
    assert.equal((await send('/actions',body,{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await send('/actions',{...body,version:'stale'})).status,409);
    assert.equal((await send('/actions',{...body,padding:'x'.repeat(17000)})).status,413);
    assert.equal((await send('/actions',body)).status,200);
    assert.equal((await (await send('')).json()).jobs.length,0);
    const archived=(await (await send('',{view:'archived'})).json()).jobs;
    assert.equal(archived.length,1);assert.ok(archived[0].archivedAt);
    assert.equal((await send('/actions',{key:item.key,action:'restore',version:archived[0].actionVersion})).status,200);
    assert.equal((await (await send('')).json()).jobs.length,1);
  }finally{await new Promise(r=>server.close(r));}
});

test('归档先分组再分页，较新历史不挤掉活跃任务且旧归档可访问',async()=>{
  const {default:http}=await import('node:http');const {panelHandler}=await import('../src/panel-api.mjs');
  const items=Array.from({length:101},(_,i)=>({id:String(i),key:`request:${i}`,status:'failed',createdAt:`2026-${String(i).padStart(3,'0')}`,archivedAt:'2026-10-13'}));
  items.push({id:'active',key:'request:active',status:'planning',createdAt:'2025-01-01'});
  const server=http.createServer(panelHandler({list:()=>[],active:new Map()},{list:()=>items,active:new Map()}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const send=body=>fetch(`http://127.0.0.1:${server.address().port}/gpt-workflow-view`,{method:'POST',headers:{'Content-Type':'application/json','X-GPT-Workflow-View':'1'},body:JSON.stringify(body)}).then(r=>r.json());
  try{
    assert.equal((await send({})).jobs[0].key,'request:active');
    const first=await send({view:'archived'});assert.equal(first.jobs.length,100);assert.equal(first.hasMore,true);
    const last=await send({view:'archived',offset:100});assert.equal(last.jobs.length,1);assert.equal(last.hasMore,false);
  }finally{await new Promise(r=>server.close(r));}
});

test('缺少 PID 或 interrupted 的异常任务可清理重做与移入回收站，运行中进程仍拒绝清理',async()=>{
  const f=fixture(),item=await failed(f);
  const task=f.workflow.load((await f.workflow.create({repo:f.repo,title:'卡死开发',plan})).id);
  task.status='running';task.attempt=1;f.workflow.save(task);
  fs.writeFileSync(f.workflow.lockPath(f.repo),JSON.stringify({id:task.id,home:f.workflow.home}),{mode:0o600});
  const storeHome=path.join(f.home,'store');fs.mkdirSync(storeHome,{recursive:true});
  const jobFile=path.join(storeHome,`${task.id}-1.json`);
  fs.writeFileSync(jobFile,JSON.stringify({key:`${task.id}-1`,status:'interrupted',title:'卡死开发',repo:f.repo,createdAt:'2026-10-13T00:00:00.000Z'}));
  f.store.home=storeHome;f.store.list=()=>fs.readdirSync(storeHome).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(storeHome,n),'utf8')));
  f.store.file=k=>path.join(storeHome,`${k}.json`);
  f.requests.save({...item,status:'interrupted',gptSessionState:'owned',gptPid:process.pid,taskId:task.id});
  for(const action of ['reprocess','remove'])await assert.rejects(f.run(item.key,action),/运行/);
  f.requests.save({...f.requests.get(item.id),gptPid:undefined});
  let replanned=0;
  f.requests.plan=async(_item,update)=>{replanned++;update({gptSessionState:'released'});return {status:'needs_input',questions:'重新规划成功'};};
  const reprocessed=await f.run(`${task.id}-1`,'reprocess');
  assert.equal(reprocessed.focusKey,item.key);
  await f.requests.active.get(item.id);
  assert.equal(replanned,1);
  assert.equal(f.requests.get(item.id).status,'needs_input');
  assert.equal(fs.existsSync(f.workflow.lockPath(f.repo)),false);
  assert.equal(fs.existsSync(jobFile),false);
  assert.ok(fs.readdirSync(path.join(storeHome,'trash')).length>=1);
  assert.ok(fs.readdirSync(path.join(f.workflow.home,'trash')).length>=1);
  await f.run(item.key,'remove');
  assert.equal(f.requests.list().length,0);
  assert.ok(fs.readdirSync(path.join(f.requests.home,'trash')).length>=2);
});

