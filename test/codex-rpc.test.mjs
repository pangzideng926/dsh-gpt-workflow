import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CodexRpc } from '../src/codex-rpc.mjs';

function fixture(onToolCall) {
  const child=new EventEmitter(); child.stdin=new PassThrough();child.stdout=new PassThrough(); child.kill=()=>child.emit('close',0);
  const replies=[];child.stdin.on('data',buf=>replies.push(JSON.parse(buf.toString())));
  const client=new CodexRpc('unused',{spawnProcess:()=>child,onToolCall});
  const send=data=>child.stdout.write(JSON.stringify(data)+'\n');
  const finish=()=>{client.close();child.emit('close',0);child.stdout.end();};
  return {client,replies,send,finish};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('仅动态工具请求交给规划处理器，并返回原始请求 ID',async()=>{
  const response={success:true,contentItems:[{type:'inputText',text:'已接收'}]};let params;
  const f=fixture(async input=>{params=input;return response;});
  try {
    f.send({id:41,method:'item/tool/call',params:{tool:'submit_planning_result'}});await tick();
    assert.equal(params.tool,'submit_planning_result');assert.deepEqual(f.replies,[{id:41,result:response}]);
    assert.equal(f.client.closed,undefined);
  }finally {f.finish();}
});
test('权限请求仍拒绝，不交给结果工具处理器',async()=>{
  let called=false;const f=fixture(()=>{called=true;});
  try {
    f.send({id:42,method:'item/commandExecution/requestApproval',params:{}});await tick();
    assert.equal(called,false);assert.equal(f.replies[0].error.code,-32601);assert.equal(f.client.closed,true);
  }finally {f.finish();}
});
test('工具处理器异常导致失败，不伪造成功响应',async()=>{
  const f=fixture(()=>{throw new Error('回合不匹配');});
  try {
    f.send({id:43,method:'item/tool/call',params:{}});await tick();
    assert.match(f.client.failure.message,/回合不匹配/);assert.equal(f.replies[0].error.code,-32602);
  }finally {f.finish();}
});
