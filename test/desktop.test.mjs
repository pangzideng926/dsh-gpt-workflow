import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/workflow.mjs';
import { ReceiverStore } from '../src/receiver-store.mjs';
import { serveReceiver } from '../src/receiver-http.mjs';

test('桌面接收端完整传输：派单、worker 回传、GPT 审查同步且不会重复开发', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture'); git('add', 'README.md'); git('commit', '-m', '初始化');
  let count = 0;
  const store = new ReceiverStore(path.join(root, 'receiver'), async () => {
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
    const task = await workflow.create({ repo, title: '桌面闭环', plan });
    await workflow.start(task.id);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await workflow.status(task.id);
      if (status.status !== 'running') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'awaiting_review'); assert.equal(count, 1);
    const result = await workflow.result(task.id);
    const review = { verdict: 'approved', summary: '离线传输验证通过', evidenceHash: result.evidenceHash };
    assert.equal((await workflow.review(task.id, review)).reviewDelivery, 'delivered');
    assert.equal((await workflow.review(task.id, review)).reviewDelivery, 'delivered');
    assert.equal(store.list()[0].review.verdict, 'approved');
    assert.equal(workflow.load(task.id).reviewDelivery, 'delivered');
    assert.equal(store.list()[0].plan, plan);
    assert.equal(count, 1);
  } finally {
    if (before === undefined) delete process.env.DSH_WORKFLOW_RECEIVER_FILE; else process.env.DSH_WORKFLOW_RECEIVER_FILE = before;
    await new Promise(resolve => server.close(resolve));
  }
});
