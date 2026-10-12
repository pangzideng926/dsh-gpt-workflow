import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCodexWorkspaces } from '../src/codex-workspaces.mjs';

test('Codex 工作区从项目接口分页读取，去重并排除非本机目录，不创建会话',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'codex-workspaces-')),calls=[];
  let closed=false;
  const client={request:async(method,params)=>{calls.push({method,params});return {data:[{id:'p',name:'项目',roots:[{path:home},{path:path.join(home,'missing')},{path:'relative'}]}],nextCursor:calls.length===1?'next':null};},close:()=>{closed=true;}};
  const result=await listCodexWorkspaces({connect:async()=>client,resolveBin:()=>'/fake/codex'});
  assert.equal(result.workspaces.length,1); assert.equal(result.workspaces[0].path,(await fs.realpath(home)).replaceAll('\\','/'));
  assert.ok(calls.every(c=>c.method==='project/list')); assert.equal(calls[1].params.cursor,'next'); assert.equal(closed,true);
});
test('Codex 项目接口不可用时报告错误并关闭客户端',async()=>{
  let closed=false;
  await assert.rejects(listCodexWorkspaces({connect:async()=>({request:async()=>{throw new Error('旧版接口不可用');},close:()=>{closed=true;}}),resolveBin:()=>'/fake'}),/旧版接口不可用/);
  assert.equal(closed,true);
});
