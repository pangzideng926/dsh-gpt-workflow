import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {QuickRequests} from '../src/quick-requests.mjs';
function fixture(t) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'zentao-link-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 let plans=0;
 const workflow={load:()=>{throw new Error('missing');}};
 const requests=new QuickRequests(path.join(home,'requests'),{workflow,plan:async()=>{plans++;return {status:'needs_input',questions:'补充验收'};}});
 return {home,workflow,requests,plans:()=>plans,input:{id:randomUUID(),workspace:home,requirement:'修复工单下载',source:{provider:'zentao',server:'https://zentao.example/zentao/',kind:'task',id:42,title:'工单下载'}}};
}
test('同条目并发、内容变化和重启均复用原关联',async t=>{
 const f=fixture(t);
 const [a,b]=await Promise.all([f.requests.accept(f.input),f.requests.accept({...f.input,id:randomUUID()})]);
 assert.equal(a.id,b.id); await f.requests.active.get(a.id); assert.equal(f.plans(),1);
 assert.equal(a.source.url,'https://zentao.example/zentao/task-view-42.html');
 const restarted=new QuickRequests(path.join(f.home,'requests'),{workflow:f.workflow,plan:()=>{throw new Error('禁止重放');}});
 const old=await restarted.accept({...f.input,id:randomUUID(),workspace:path.join(f.home,'已移动'),requirement:'标题内容改变'});
 assert.equal(old.id,a.id); assert.equal(old.requirement,f.input.requirement); assert.equal(old.status,'needs_input');
});
test('服务器、类别、编号隔离，拒绝来源地址携带凭据',async t=>{
 const f=fixture(t), ids=[];
 for(const source of [f.input.source,{...f.input.source,kind:'bug'},{...f.input.source,id:43},{...f.input.source,server:'https://other.example/zentao'}]) {
 const item=await f.requests.accept({...f.input,id:randomUUID(),source}); await f.requests.active.get(item.id); ids.push(item.id);
 }
 assert.equal(new Set(ids).size,4);
 for(const server of ['javascript:alert(1)','https://user:secret@zentao.example','https://zentao.example/?token=secret']) await assert.rejects(f.requests.accept({...f.input,id:randomUUID(),source:{...f.input.source,server}}),/来源|服务器/);
});
test('规划中重启保留中断关联，不重新规划',async t=>{
 const f=fixture(t);f.requests.plan=()=>new Promise(()=>{});
 const item=await f.requests.accept(f.input);
 const restarted=new QuickRequests(path.join(f.home,'requests'),{workflow:f.workflow,plan:()=>{throw new Error('禁止重放');}});
 const same=await restarted.accept({...f.input,id:randomUUID()});
 assert.equal(same.id,item.id);assert.equal(same.status,'interrupted');assert.equal(restarted.list().length,1);
});
