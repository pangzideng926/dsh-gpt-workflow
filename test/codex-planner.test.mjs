import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPlanner } from '../src/codex-planner.mjs';

class Client extends EventEmitter {
  calls = [];
  async request(method, params) {
    this.calls.push({method, params});
    if (method === 'thread/start') return {thread:{id:'test-thread'}};
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', {method:'item/completed',params:{threadId:'test-thread',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({status:'ready',title:'示例',plan:'方案',questions:''})}}});
        this.emit('notification', {method:'turn/completed',params:{threadId:'test-thread',turn:{status:this.fail?'failed':'completed',error:{message:'模型不可用'}}}});
      });
      return {turn:{id:'turn'}};
    }
    return {};
  }
  close() { this.closed = true; }
}
test('规划使用可见持久会话，在推理前保存 ID，并保留只读权限', async () => {
  const client = new Client(), updates = [], home = fs.mkdtempSync(path.join(os.tmpdir(),'gpt-planner-'));
  const plan = createPlanner(home, undefined, {connect:async()=>client});
  const result = await plan({id:'request',repo:home,requirement:'示例'}, update=>updates.push(update));
  assert.equal(result.title,'示例');
  assert.equal(updates[0].gptThreadId,'test-thread');
  const start = client.calls.find(c=>c.method==='thread/start').params;
  assert.equal(start.ephemeral,false); assert.equal(start.sandbox,'read-only');
  assert.equal(start.threadSource,'user');
  assert.equal(client.calls.at(-1).method,'thread/name/set');
  assert.equal(client.closed,true);
});
test('模型失败保留会话并停止派发，不能把部分回复当作成功方案', async () => {
  const client = new Client(); client.fail = true;
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-planner-'));
  await assert.rejects(createPlanner(home,undefined,{connect:async()=>client})({id:'request',repo:home,requirement:'示例'},()=>{}),/模型不可用/);
  assert.equal(client.closed,true);
});
