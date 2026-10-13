import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Workflow } from '../src/workflow.mjs';
import { QuickRequests } from '../src/quick-requests.mjs';
import { currentDshWorkspace } from '../src/workspace-selection.mjs';

const plan = '## 目标与范围\n文档\n## 代码依据\nREADME.md\n## 实施步骤\n修改文档\n## 验收标准\n内容完整\n## 测试要求\n检查文档';
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-routing-')), workspace=path.join(home,'workspace');
  fs.mkdirSync(workspace); const repos=['one','two'].map(name=>path.join(workspace,name));
  for (const repo of repos) {
    fs.mkdirSync(repo); const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',windowsHide:true});
    git('init','-b','main'); git('config','user.name','Test'); git('config','user.email','test@example.invalid');
    fs.writeFileSync(path.join(repo,'README.md'),'fixture','utf8'); git('add','.'); git('commit','-m','初始化');
  }
  const workflow=new Workflow({home:path.join(home,'workflow')}), starts=[];
  workflow.start=async id=>starts.push(id);
  const phases=[];
  const requests=new QuickRequests(path.join(home,'requests'),{workflow,plan:async request=>{
    phases.push(request.stage);
    return request.stage==='locate' ? {status:'ready',repos:[repos[0]],reason:'定位到 README',title:'文档'} : {status:'ready',title:'文档',tasks:request.repos.map(repo=>({repo,title:path.basename(repo),plan}))};
  }});
  return {home,workspace,repos,workflow,starts,phases,requests,input:{id:randomUUID(),workspace,requirement:'改文档'}};
}
async function finish(f,input=f.input) {const item=await f.requests.accept(input); await f.requests.active.get(item.id); return f.requests.get(item.id);}

test('非 Git 工作区自动识别子仓库，不让用户先选仓库，重复请求只派发一次',async()=>{
  const f=fixture(), item=await finish(f);
  assert.equal(item.status,'dispatched'); assert.equal(item.workspace,fs.realpathSync.native(f.workspace));
  assert.deepEqual(f.phases,['locate','plan']); assert.equal(f.workflow.load(item.taskId).repo,fs.realpathSync.native(f.repos[0]));
  await finish(f); assert.equal(f.starts.length,1);
});
test('多仓库先完成统一规划再分别派发，保留全部任务关联',async()=>{
  const f=fixture(); f.requests.plan=async request=>request.stage==='locate' ? {status:'ready',repos:f.repos} : {status:'ready',title:'跨仓库',tasks:request.repos.map(repo=>({repo,title:path.basename(repo),plan}))};
  const item=await finish(f); assert.equal(item.status,'dispatched'); assert.equal(item.taskIds.length,2); assert.deepEqual(item.taskIds,f.starts);
});
test('无法确定仓库时保留待补充，拒绝工作区外和工作区根目录的伪目标',async()=>{
  const f=fixture(); f.requests.plan=async()=>({status:'needs_input',questions:'请说明具体功能'});
  assert.equal((await finish(f)).status,'needs_input');
  for (const repo of [f.home,f.workspace]) {
    f.requests.plan=async()=>({status:'ready',repos:[repo]});
    assert.equal((await finish(f,{...f.input,id:randomUUID()})).status,'failed');
  }
  assert.equal(f.starts.length,0);
});
test('允许自动识别的目标仓库存在既有未提交改动；规划期间变化仍不派发',async()=>{
  const f=fixture();
  fs.writeFileSync(path.join(f.repos[0],'README.md'),'existing dirty 0','utf8');
  fs.writeFileSync(path.join(f.repos[1],'README.md'),'existing dirty 1','utf8');
  f.requests.plan=async request=>request.stage==='locate'
    ? {status:'ready',repos:f.repos,reason:'双仓'}
    : {status:'ready',tasks:request.repos.map(repo=>({repo,title:'文档',plan}))};
  assert.equal((await finish(f)).status,'dispatched');
  assert.equal(f.starts.length,2);
  f.requests.plan=async request=>{
    if(request.stage==='locate')return {status:'ready',repos:[f.repos[0]]};
    fs.writeFileSync(path.join(f.repos[0],'README.md'),'changed during plan','utf8');
    return {status:'ready',tasks:[{repo:f.repos[0],title:'文档',plan}]};
  };
  assert.match((await finish(f,{...f.input,id:randomUUID()})).error,/规划期间代码发生变化/);
  assert.equal(f.starts.length,2);
});
test('规划不能偷偷增加仓库，部分启动失败保留所有任务且不会重放',async()=>{
  const f=fixture(); f.requests.plan=async request=>request.stage==='locate' ? {status:'ready',repos:[f.repos[0]]} : {status:'ready',tasks:f.repos.map(repo=>({repo,title:'文档',plan}))};
  assert.equal((await finish(f)).status,'failed'); assert.equal(f.starts.length,0);
  f.requests.plan=async request=>request.stage==='locate' ? {status:'ready',repos:f.repos} : {status:'ready',tasks:request.repos.map(repo=>({repo,title:'文档',plan}))};
  f.workflow.start=async id=>{ f.starts.push(id); if(f.starts.length===2)throw new Error('启动失败'); };
  const input={...f.input,id:randomUUID()}, item=await finish(f,input);
  assert.equal(item.status,'failed'); assert.equal(item.taskIds.length,2); await finish(f,input); assert.equal(f.starts.length,2);
});
test('默认工作区仅取当前主面板所属项，不猜测最近工作区',()=>{
  const workspaces={items:[{workspaceId:'a',path:'E:/A',sessionIds:['one']},{workspaceId:'b',path:'E:/B',sessionIds:['two']}]};
  assert.equal(currentDshWorkspace({byId:{one:{id:'one',retainedBy:{mainView:1}},two:{id:'two'}}},workspaces).path,'E:/A');
  assert.equal(currentDshWorkspace({byId:{two:{id:'two'}}},workspaces),undefined);
});

test('定位阶段更新目标仓库，仓库被占用时在 GPT 最终回复之前提供暂停原因',async()=>{
  const f=fixture();
  fs.writeFileSync(f.workflow.lockPath(f.repos[0]),JSON.stringify({id:randomUUID()}),'utf8');
  let inspected=false;
  f.requests.plan=async (request,update,inspect)=>{
    assert.equal(request.stage,'locate');
    const located={status:'ready',repos:[f.repos[0]],reason:'代码依据'};
    assert.equal(typeof inspect,'function');
    assert.throws(()=>inspect(located),/已有开发\/审查任务/);
    inspected=true; return located;
  };
  const item=await finish(f), realRepo=fs.realpathSync.native(f.repos[0]);
  assert.equal(inspected,true); assert.match(item.error,/已有开发\/审查任务/);
  assert.equal(item.repo,realRepo); assert.deepEqual(item.repos,[realRepo]);
  assert.equal(item.status,'failed'); assert.equal(f.starts.length,0);
});
