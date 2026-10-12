import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPlanner } from '../src/codex-planner.mjs';

class Client extends EventEmitter {
  calls = [];
  constructor(options = {}) { super(); this.options = options; }
  async request(method, params) {
    this.calls.push({method, params});
    if (method === 'thread/start' || method === 'thread/resume') return {thread:{id:'test-thread'}};
    if (method === 'turn/start') {
      setImmediate(async () => {
        const result=this.result || {status:'ready',title:'示例',plan:'方案',questions:''};
        const args={stage:this.stage || 'legacy',repos:[],reason:'',tasks:[],plan:'',...result};
        const toolParams={threadId:'test-thread',turnId:'turn',callId:'call',tool:'submit_planning_result',arguments:args,...this.toolOverride};
        try {
          if (!this.skipTool) this.toolReply=await this.options.onToolCall?.(toolParams);
          if (this.repeatTool) this.repeatReply=await this.options.onToolCall?.(toolParams);
        } catch(error) {this.emit('failure',error);return;}
        this.emit('notification', {method:'turn/completed',params:{threadId:'test-thread',turn:{id:'unrelated-turn',status:'failed',error:{message:'不相关回合失败'}}}});
        this.emit('notification', {method:'item/completed',params:{threadId:'test-thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'# 示例\n\n可读的规划结果'}}});
        this.emit('notification', {method:'item/completed',params:{threadId:'test-thread',turnId:'turn',item:{type:'agentMessage',phase:'commentary',text:'这不是最终结果'}}});
        this.emit('notification', {method:'turn/completed',params:{threadId:'test-thread',turn:{id:'turn',status:this.fail?'failed':'completed',error:{message:'模型不可用'}}}});
      });
      return {turn:{id:'turn'}};
    }
    return {};
  }
  close() { this.closed = true; }
}
test('规划使用可见持久会话，在推理前保存 ID，并保留只读权限', async () => {
  const client = new Client(), updates = [], home = fs.mkdtempSync(path.join(os.tmpdir(),'gpt-planner-'));
  const plan = createPlanner(home, undefined, {connect:async(_bin,options)=>{client.options=options;return client;}});
  const result = await plan({id:'request',repo:home,requirement:'示例'}, update=>updates.push(update));
  assert.equal(result.title,'示例');
  assert.equal(updates[0].gptThreadId,'test-thread');
  const start = client.calls.find(c=>c.method==='thread/start').params;
  assert.equal(start.ephemeral,false); assert.equal(start.sandbox,'read-only');
  assert.equal(start.threadSource,'user');
  assert.equal(start.dynamicTools[0].name,'submit_planning_result');
  assert.equal(client.calls.find(c=>c.method==='turn/start').params.outputSchema,undefined);
  assert.equal(client.toolReply.success,true);
  assert.match(fs.readFileSync(path.join(home,'request','legacy-answer.md'),'utf8'),/^# 示例/);
  assert.equal(client.calls.at(-1).method,'thread/name/set');
  assert.equal(client.closed,true);
  assert.equal(updates.at(-1).gptSessionState,'released');
  assert.ok(updates.some(update=>update.gptProgress));
});
test('模型失败保留会话并停止派发，不能把部分回复当作成功方案', async () => {
  const client = new Client(); client.fail = true;
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-planner-'));
  await assert.rejects(createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{}),/模型不可用/);
  assert.equal(client.closed,true);
});

test('工作区先定位再规划，第二阶段续接同一 GPT 会话且保持只读',async()=>{
  const clients=[],home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-workspace-planner-'));
  const planner=createPlanner(home,undefined,{connect:async(_bin,options)=>{const c=new Client(options); clients.push(c); c.stage=clients.length===1?'locate':'plan'; c.result=clients.length===1?{status:'ready',title:'文档',repos:[home],reason:'代码依据',questions:''}:{status:'ready',title:'文档',tasks:[{repo:home,title:'文档',plan:'方案'}],questions:''};return c;}});
  const request={id:'workspace',workspace:home,repo:home,requirement:'修改文档',stage:'locate'};
  const first=await planner(request,update=>Object.assign(request,update));
  assert.deepEqual(first.repos,[home]);
  request.stage='plan'; request.repos=first.repos;
  const second=await planner(request,update=>Object.assign(request,update));
  assert.equal(second.tasks.length,1);
  const resume=clients[1].calls.find(c=>c.method==='thread/resume');
  assert.equal(resume.params.threadId,'test-thread'); assert.equal(resume.params.cwd,home); assert.equal(resume.params.sandbox,'read-only');
  assert.ok(!clients[1].calls.some(c=>c.method==='thread/start'));
  assert.ok(clients.every(c=>c.closed));
  assert.match(clients[0].calls.find(c=>c.method==='turn/start').params.input[0].text,/禁止在仅有/);
});

test('只有可读回复但缺少结构化交接时必须停止，不猜测方案',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-missing-result-'));
  const client=new Client();client.skipTool=true;
  await assert.rejects(createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{}),/未提交结构化规划结果/);
  assert.equal(fs.existsSync(path.join(home,'request','legacy-result.json')),false);
});

test('预检查暂停原因通过工具反馈供 GPT 显示，不追加模型回合',async()=>{
  const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-feedback-'));
  const planner=createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}});
  await planner({id:'request',repo:home,requirement:'示例'},()=>{},()=>{throw new Error('仓库有未提交改动：示例仓库');});
  assert.match(client.toolReply.contentItems[0].text,/已暂停.*未提交改动/);
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('待补充问题走工具交接，最终消息仍为 Markdown',async()=>{
  const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-questions-'));
  client.result={status:'needs_input',title:'待补充',questions:'请确定数量计算规则'};
  const result=await createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{});
  assert.equal(result.status,'needs_input');assert.match(result.questions,/数量/);
  assert.match(client.toolReply.contentItems[0].text,/不会派发 DSH/);
});


test('拒绝其它会话、回合或工具的结果，不能生成可派发文件',async()=>{
  for (const toolOverride of [{threadId:'other'},{turnId:'other'},{tool:'approve_permission'},{namespace:'other'}]) {
    const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-scoped-result-'));
    client.toolOverride=toolOverride;
    await assert.rejects(createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{}),/拒绝非当前/);
    assert.equal(fs.existsSync(path.join(home,'request','legacy-result.json')),false);
  }
});

test('相同结果重试不重复检查且保留暂停反馈',async()=>{
  const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-repeat-result-'));client.repeatTool=true;let checks=0;
  await createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{},()=>{checks++;throw new Error('仓库已占用');});
  assert.equal(checks,1);assert.deepEqual(client.repeatReply,client.toolReply);assert.match(client.repeatReply.contentItems[0].text,/仓库已占用/);
});

test('规划进程尚未退出时不能提前完成交接',async()=>{
  const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-release-'));
  let release, closing;const beganClose=new Promise(resolve=>{closing=resolve;});
  client.close=()=>{closing();return new Promise(resolve=>{release=resolve;});};
  const pending=createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},()=>{});
  let settled=false;pending.then(()=>{settled=true;});
  await beganClose;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'必须等到自己的 App Server 退出后再交接');
  release();await pending;
});


test('释放失败不能当作可交接成功，并留下占用状态',async()=>{
  const client=new Client(),home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-release-failed-')),updates=[];
  client.close=async()=>{throw new Error('规划进程未退出');};
  await assert.rejects(createPlanner(home,undefined,{connect:async(_bin,options)=>{client.options=options;return client;}})({id:'request',repo:home,requirement:'示例'},update=>updates.push(update)),/进程未退出/);
  assert.equal(updates.at(-1).gptSessionState,'release_failed');
});
