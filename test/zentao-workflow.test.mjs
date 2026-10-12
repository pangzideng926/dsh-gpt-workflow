import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/workflow.mjs';
import { ReceiverStore } from '../src/receiver-store.mjs';
import { serveReceiver } from '../src/receiver-http.mjs';
import {QuickRequests} from '../src/quick-requests.mjs';
import {zentaoProgress} from '../src/zentao-source.mjs';

test('禅道来源离线闭环：自动定位、规划、DSH 回传、审查及重启复用关联', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture'); git('add', 'README.md'); git('commit', '-m', '初始化');
  let count = 0;
  const store = new ReceiverStore(path.join(root, 'receiver'), async request => {
    assert.equal(request.handoff.id, request.id);
    assert.equal(request.handoff.baseline.fingerprint, request.baseline);
    assert.match(request.prompt, /Active task:/);
    assert.match(request.prompt, /## 测试记录/);
    count++; fs.writeFileSync(path.join(repo, 'result.txt'), '桌面传输替身');
    return { answer: '完成', exitCode: 0 };
  });
  const { server, url } = await serveReceiver(store, 'test-token');
  const config = path.join(root, 'connection.json'); fs.writeFileSync(config, JSON.stringify({ url, token: 'test-token' }));
  const before = process.env.DSH_WORKFLOW_RECEIVER_FILE;
  process.env.DSH_WORKFLOW_RECEIVER_FILE = config;
  const workflow = new Workflow({ home: path.join(root, 'workflow') });
  try {
    const plan = '## 目标与范围\n传输验证\n## 代码依据\nREADME.md\n## 实施步骤\n新增 result.txt\n## 验收标准\n文件存在\n## 测试要求\n核对文件';
    let plans=0;
    const planning=async request=>{plans++;return request.stage==='locate' ? {status:'ready',repos:[repo]} : {status:'ready',title:'禅道闭环',tasks:[{repo,title:'禅道闭环',plan}]};};
    const requests=new QuickRequests(path.join(root,'requests'),{workflow,plan:planning});
    const input={workspace:root,requirement:'只新增 result.txt，用于离线验证',source:{provider:'zentao',server:'https://zentao.example',kind:'task',id:'42',title:'测试'}};
    const request=await requests.accept(input);await requests.active.get(request.id);
    const associated=requests.get(request.id);assert.equal(associated.status,'dispatched');assert.equal(plans,2);
    const task=workflow.load(associated.taskId);
    const progress=()=>zentaoProgress(requests.get(request.id),workflow,store.list());
    let status;
    for (let i = 0; i < 100; i++) {
      status = await workflow.status(task.id);
      if (status.status !== 'running') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'awaiting_review'); assert.equal(count, 1);
    assert.equal(progress().status,'completed');
    const result = await workflow.result(task.id);
    const review = { verdict: 'approved', summary: '离线传输验证通过', evidenceHash: result.evidenceHash };
    assert.equal((await workflow.review(task.id, review)).reviewDelivery, 'delivered');
    assert.equal((await workflow.review(task.id, review)).reviewDelivery, 'delivered');
    assert.equal(store.list()[0].review.verdict, 'approved');
    assert.equal(workflow.load(task.id).reviewDelivery, 'delivered');
    assert.equal(store.list()[0].plan, plan);
    const { sections, ...metadata } = (await workflow.handoff(task.id)).packet;
    assert.deepEqual(store.list()[0].handoff, metadata);
    assert.equal(progress().status,'approved');
    const restarted=new QuickRequests(path.join(root,'requests'),{workflow,plan:planning});
    const again=await restarted.accept({...input,requirement:'重新点击同一条目'});
    assert.equal(again.id,request.id);assert.equal(plans,2);assert.equal(count,1);
  } finally {
    if (before === undefined) delete process.env.DSH_WORKFLOW_RECEIVER_FILE; else process.env.DSH_WORKFLOW_RECEIVER_FILE = before;
    await new Promise(resolve => server.close(resolve));
  }
});
