import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { panelHandler } from '../src/panel-api.mjs';
import { codexThreadUrl } from '../src/codex-open.mjs';

test('面板快速创建被接收，跨站、缺少标头和超大请求不能派单', async () => {
  let calls = 0;
  const server = http.createServer(panelHandler({ list: () => [] }, { list: () => [], accept: async body => { calls++; return { id: body.id }; } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/gpt-workflow-view/requests`;
  try {
    const send = (body, headers = {}) => fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal((await send('{}')).status, 403);
    assert.equal((await send('{}', { 'X-GPT-Workflow-View': '1', Origin: 'https://evil.invalid' })).status, 403);
    const good = await send('{"id":"test"}', { 'X-GPT-Workflow-View': '1', Origin: 'dsh-app://app' });
    assert.equal(good.status, 202);
    assert.equal(calls, 1);
    assert.equal((await send('x'.repeat(70000), { 'X-GPT-Workflow-View': '1' })).status, 413);
    assert.equal(calls, 1);
  } finally { await new Promise(r => server.close(r)); }
});

test('打开 GPT 仅接受已关联任务，不接受任意会话或外部 URI', async () => {
  const thread='01a12e5a-ed9f-79e0-a1e1-5021be4aa6f3', opened=[];
  const requests={list:()=>[{key:'request:abc',taskId:'task',gptThreadId:thread}]};
  const server=http.createServer(panelHandler({list:()=>[{key:'task-2'}]},requests,{openThread:async id=>opened.push(id)}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/gpt-workflow-view/open-gpt`;
  const send=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-GPT-Workflow-View':'1',...headers},body:JSON.stringify(body)});
  try {
    assert.equal((await send({key:'task-2'},{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await send({key:'unknown',gptThreadId:thread})).status,404);
    assert.equal((await send({key:'request:abc'})).status,200);
    assert.equal((await send({key:'task-2'})).status,200);
    assert.deepEqual(opened,[thread,thread]);
    assert.equal(codexThreadUrl(thread),`codex://threads/${thread}`);
    assert.throws(()=>codexThreadUrl("'; calc; '"),/ID 无效/);
  } finally {await new Promise(r=>server.close(r));}
});
