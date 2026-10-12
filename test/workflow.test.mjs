import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/workflow.mjs';

const fake = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url));
const plan = '# 实施方案\n\n## 目标与范围\n生成 result.txt。\n\n## 代码依据\nREADME.md。\n\n## 实施步骤\n创建 result.txt。\n\n## 验收标准\n内容正确。\n\n## 测试要求\n读取文件。';
async function setup(mode = 'ok') {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-gpt-test-'));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'pipe' });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' });
  git('config', 'user.name', 'Offline Test');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(path.join(repo, 'README.md'), 'fixture\n');
  git('add', 'README.md'); git('commit', '-m', '初始化测试仓库');
  const workflow = new Workflow({ home: path.join(root, 'state'), command: { file: process.execPath, args: [fake, mode] }, timeoutMs: 10000 });
  return { workflow, repo, git };
}
async function completed(workflow, id) {
  for (let n = 0; n < 160; n++) {
    const task = await workflow.status(id);
    if (task.status !== 'running') return task;
    await new Promise(r => setTimeout(r, 75));
  }
  throw new Error('离线任务超时');
}
test('新任务必须停在 planned，生成可阅读实施文档', async () => {
  const { workflow, repo } = await setup();
  const task = await workflow.create({ repo, title: '示例', plan });
  assert.equal(task.status, 'planned');
  assert.match(await readFile(task.planPath, 'utf8'), /实施方案/);
});
test('拒绝接管已有未提交改动的仓库', async () => {
  const { workflow, repo } = await setup();
  await writeFile(path.join(repo, 'user.txt'), '用户内容');
  await assert.rejects(workflow.create({ repo, title: '示例', plan }), /未提交/);
});
test('计划生成后代码变动，启动时拒绝旧基线', async () => {
  const { workflow, repo } = await setup();
  const task = await workflow.create({ repo, title: '示例', plan });
  await writeFile(path.join(repo, 'README.md'), '他人的编辑');
  await assert.rejects(workflow.start(task.id), /基线/);
});
test('仓库独占锁阻止重复任务，运行中不能审查', async () => {
  const { workflow, repo } = await setup('slow');
  const a = await workflow.create({ repo, title: '甲', plan });
  const b = await workflow.create({ repo, title: '乙', plan });
  await workflow.start(a.id);
  await assert.rejects(workflow.start(b.id), /锁定/);
  await assert.rejects(workflow.review(a.id, { verdict: 'approved', summary: '通过' }), /状态/);
  assert.equal((await completed(workflow, a.id)).status, 'awaiting_review');
});
test('退出成功只进入待审查，GPT 明确审查后通过', async () => {
  const { workflow, repo } = await setup();
  const task = await workflow.create({ repo, title: '示例', plan });
  await workflow.start(task.id);
  assert.equal((await completed(workflow, task.id)).status, 'awaiting_review');
  const evidence = await workflow.result(task.id);
  assert.match(evidence.answer, /离线替身/);
  assert.ok(evidence.changedFiles.includes('result.txt'));
  const approved = await workflow.review(task.id, { verdict: 'approved', summary: '已读取 result.txt，内容符合验收', evidenceHash: evidence.evidenceHash });
  assert.equal(approved.status, 'approved');
});
test('审查后代码发生变化，禁止按旧证据批准', async () => {
  const { workflow, repo } = await setup();
  const task = await workflow.create({ repo, title: '示例', plan });
  await workflow.start(task.id); await completed(workflow, task.id);
  const evidence = await workflow.result(task.id);
  await writeFile(path.join(repo, 'result.txt'), '后续写入');
  await assert.rejects(workflow.review(task.id, { verdict: 'approved', summary: '通过', evidenceHash: evidence.evidenceHash }), /代码.*变化/);
});
test('失败退出即使有 final 也不能进入待审查', async () => {
  const { workflow, repo } = await setup('fail');
  const task = await workflow.create({ repo, title: '示例', plan });
  await workflow.start(task.id);
  assert.equal((await completed(workflow, task.id)).status, 'failed');
});
test('零退出码但缺少 final 必须失败', async () => {
  const { workflow, repo } = await setup('missing-final');
  const task = await workflow.create({ repo, title: '示例', plan });
  await workflow.start(task.id);
  assert.equal((await completed(workflow, task.id)).status, 'failed');
});
test('驳回后带着审查意见修订，再次开发并保留上轮证据', async () => {
  const { workflow, repo } = await setup();
  const task = await workflow.create({ repo, title: '示例', plan });
  await workflow.start(task.id); await completed(workflow, task.id);
  const evidence = await workflow.result(task.id);
  await workflow.review(task.id, { verdict: 'needs_changes', summary: '补充说明', evidenceHash: evidence.evidenceHash });
  const updated = await workflow.revise(task.id, { plan: plan + '\n补充说明。' });
  assert.equal(updated.status, 'planned');
  await workflow.start(task.id);
  const done = await completed(workflow, task.id);
  assert.equal(done.status, 'awaiting_review');
  assert.equal(done.attempt, 2);
});
test('超时必须结束进程并失败，不能自动判定为完成', async () => {
  const { workflow, repo } = await setup('timeout');
  workflow.timeoutMs = 1000;
  const task = await workflow.create({ repo, title: '超时', plan });
  await workflow.start(task.id);
  const done = await completed(workflow, task.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /超时/);
});
test('DSH 自行提交代码时必须报错交回 GPT 核查', async () => {
  const { workflow, repo } = await setup('commit');
  const task = await workflow.create({ repo, title: '禁止提前提交', plan });
  await workflow.start(task.id);
  const done = await completed(workflow, task.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Git/);
});
test('进程仍活着时禁止恢复和解除锁', async () => {
  const { workflow, repo } = await setup('slow');
  const task = await workflow.create({ repo, title: '不能抢占', plan });
  await workflow.start(task.id);
  await assert.rejects(workflow.recover(task.id), /仍在运行/);
  await completed(workflow, task.id);
});
test('启动命令缺失时保存失败证据而不是卡在 running', async () => {
  const { workflow, repo } = await setup();
  workflow.command = { file: path.join(repo, 'missing-executable'), args: [] };
  const task = await workflow.create({ repo, title: '缺失命令', plan });
  await workflow.start(task.id);
  assert.equal((await completed(workflow, task.id)).status, 'failed');
  assert.match((await workflow.result(task.id)).error, /ENOENT/);
});
test('error 事件即使退出码为零也必须失败', async () => {
  const { workflow, repo } = await setup('error-event');
  const task = await workflow.create({ repo, title: '错误事件', plan });
  await workflow.start(task.id);
  assert.equal((await completed(workflow, task.id)).status, 'failed');
});
