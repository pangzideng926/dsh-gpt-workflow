import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {panelHandler} from '../src/panel-api.mjs';
test('禅道关联查询展示当前轮次、聚合多仓库状态且不被100条上限截断',async t=>{
 const source={provider:'zentao',server:'https://zentao.example/zentao',kind:'task',id:'42',title:'下载',url:'https://zentao.example/zentao/task-view-42.html'};
 const req={id:'abc',key:'request:abc',status:'dispatched',taskIds:['one'],source,workspace:'E:/workspace',createdAt:'2026-01-01'};
 const tasks={one:{id:'one',attempt:2,status:'running'}};
 const jobs=[{key:'one-1',status:'completed',review:{verdict:'approved'},createdAt:'2026-01-01'},{key:'one-2',status:'running',createdAt:'2026-01-02'}];
 for(let i=0;i<105;i++)jobs.unshift({key:`other-${i}`,createdAt:'2026-12-01'});
 const requests={list:()=>[req],get:id=>{if(id!==req.id)throw new Error('not found');return req;},workflow:{load:id=>{if(!tasks[id])throw new Error('missing');return tasks[id];}}};
 const server=http.createServer(panelHandler({list:()=>jobs},requests));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/gpt-workflow-view`;
 const send=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{'X-GPT-Workflow-View':'1','Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 const query={server:source.server,items:[{kind:'task',id:42}]};
 assert.equal((await send('/zentao-links',query,{Origin:'https://evil.invalid'})).status,403);
 async function state(){const res=await send('/zentao-links',query);assert.equal(res.status,200);return (await res.json()).links[0];}
 assert.equal((await state()).status,'running');
 tasks.one.status='awaiting_review';assert.equal((await state()).status,'completed');
 tasks.one.status='approved';assert.equal((await state()).status,'approved');
 tasks.one.status='planned';assert.equal((await state()).status,'dispatching');
 tasks.one.status='running';tasks.one.attempt=3;assert.equal((await state()).status,'running');
 const res=await send('/linked',{requestId:'abc'});assert.equal(res.status,200);const body=await res.json();
 assert.ok(body.jobs.some(j=>j.key===req.key));assert.ok(body.jobs.every(j=>j.source?.id==='42'));
 tasks.one.status='approved';tasks.two={id:'two',attempt:1,status:'failed'};req.taskIds.push('two');assert.equal((await state()).status,'failed');
 delete tasks.two;assert.equal((await state()).status,'interrupted');
 assert.equal((await send('/zentao-links',{...query,items:Array(101).fill(query.items[0])})).status,409);
 assert.equal((await send('/zentao-links',query,{'Content-Type':'text/plain'})).status,415);
});
