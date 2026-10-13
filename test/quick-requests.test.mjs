import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/workflow.mjs';
import { QuickRequests } from '../src/quick-requests.mjs';
const plan = '## 目标与范围\n文档\n## 代码依据\nREADME.md\n## 实施步骤\n修改文档\n## 验收标准\n文档完整\n## 测试要求\n检查文档';
function fixture(planner) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-quick-')), repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture'); git('add', '.'); git('commit', '-m', '初始化');
  const workflow = new Workflow({ home: path.join(home, 'workflow') }); let starts = 0;
  workflow.start = async () => { starts++; };
  const requests = new QuickRequests(path.join(home, 'requests'), { workflow, plan: planner });
  return { requests, repo, home, workflow, starts: () => starts, input: { id: randomUUID(), repo, requirement: '补充文档' } };
}
test('双击和网络重试只规划及派发一次，同 ID 不得更换内容', async () => {
  let plans = 0;
  const f = fixture(async () => { plans++; return { status: 'ready', title: '文档', plan }; });
  const [a,b] = await Promise.all([f.requests.accept(f.input), f.requests.accept(f.input)]);
  assert.equal(a.id,b.id); await f.requests.active.get(a.id);
  assert.equal(plans,1); assert.equal(f.starts(),1); assert.equal(f.requests.get(a.id).status,'dispatched');
  const task = f.workflow.load(f.requests.get(a.id).taskId); task.status = 'failed'; task.error = '监督进程启动失败'; f.workflow.save(task);
  assert.equal(f.requests.listForPanel()[0].status, 'failed');
  await assert.rejects(f.requests.accept({ ...f.input, requirement:'不同需求' }), /内容不一致/);
});
test('信息不足不创建开发任务，规划失败不能伪装派发成功', async () => {
  const f = fixture(async () => ({ status:'needs_input', questions:'请补充验收要求' }));
  const a = await f.requests.accept(f.input); await f.requests.active.get(a.id);
  assert.equal(f.requests.get(a.id).status,'needs_input'); assert.equal(f.starts(),0);
  f.requests.plan = async () => { throw new Error('模型离线'); };
  const b = await f.requests.accept({ ...f.input, id:randomUUID() }); await f.requests.active.get(b.id);
  assert.equal(f.requests.get(b.id).status,'failed'); assert.equal(f.starts(),0);
});
test('允许既有未提交改动的仓库规划派发；规划期间基线改变不启动开发', async () => {
  const f = fixture(async () => ({ status: 'ready', title: '文档', plan }));
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'existing dirty');
  const ok = await f.requests.accept(f.input); await f.requests.active.get(ok.id);
  assert.equal(f.requests.get(ok.id).status, 'dispatched'); assert.equal(f.starts(), 1);
  f.requests.plan = async () => { fs.writeFileSync(path.join(f.repo, 'README.md'), 'changed during plan'); return { status: 'ready', title: '文档', plan }; };
  const a = await f.requests.accept({ ...f.input, id: randomUUID(), requirement: '规划期变化' }); await f.requests.active.get(a.id);
  assert.match(f.requests.get(a.id).error, /代码发生变化/); assert.equal(f.starts(), 1);
});
test('同仓库规划互斥，重启后中断请求不重放', async () => {
  const f = fixture(() => new Promise(() => {}));
  const a = await f.requests.accept(f.input);
  await assert.rejects(f.requests.accept({ ...f.input, id:randomUUID() }),/已有规划/);
  const restarted = new QuickRequests(path.join(f.home,'requests'), {workflow:f.workflow,plan:()=> { throw new Error('不应调用'); }});
  assert.equal((await restarted.accept(f.input)).status,'interrupted'); assert.equal(f.starts(),0);
});
