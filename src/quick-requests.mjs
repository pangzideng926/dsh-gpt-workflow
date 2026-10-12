import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicJson, snapshot } from './workflow.mjs';

export class QuickRequests {
  constructor(home, { workflow, plan }) {
    this.home = home; this.workflow = workflow; this.plan = plan; this.active = new Map();
    fs.mkdirSync(home, { recursive: true });
    for (const item of this.list()) if (['planning', 'dispatching'].includes(item.status)) {
      this.save({ ...item, status: 'interrupted', error: '接收端曾中断，请核对 GPT 记录与任务；不会自动重复派发。' });
    }
  }
  file(id) { if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('请求 ID 无效'); return path.join(this.home, `${id}.json`); }
  get(id) { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
  save(item) { item.updatedAt = new Date().toISOString(); atomicJson(this.file(item.id), item); }
  list() { return fs.readdirSync(this.home).filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  listForPanel() {
    return this.list().map(item => {
      if (item.status !== 'dispatched' || !item.taskId) return item;
      try { const task = this.workflow.load(item.taskId); return task.status === 'failed' ? { ...item, status: 'failed', error: task.error || 'DSH 启动或开发失败，请核对任务' } : item; }
      catch { return { ...item, status: 'interrupted', error: '无法读取已派发任务，请核对任务记录' }; }
    });
  }
  async accept(input) {
    this.file(input.id);
    if (typeof input.repo !== 'string' || !path.isAbsolute(input.repo)) throw new Error('请选择具体 Git 仓库的绝对路径');
    if (typeof input.requirement !== 'string' || !input.requirement.trim() || input.requirement.length > 20000) throw new Error('需求不能为空且不能超过 20000 字符');
    const repo = fs.realpathSync.native(input.repo);
    const requirement = input.requirement.trim();
    const digest = createHash('sha256').update(JSON.stringify({ repo, requirement })).digest('hex');
    if (fs.existsSync(this.file(input.id))) {
      const old = this.get(input.id);
      if (old.digest !== digest) throw new Error('同一请求 ID 内容不一致');
      return old;
    }
    const root = fs.realpathSync.native(execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim());
    if (path.relative(repo, root)) throw new Error('请选择具体 Git 仓库根目录');
    if (this.list().some(j => j.repo === repo && ['planning', 'dispatching', 'interrupted'].includes(j.status))) throw new Error('该仓库已有规划或待核查请求，请先处理原任务');
    if (fs.existsSync(this.workflow.lockPath(repo))) throw new Error('该仓库已有开发/审查任务，请先完成原任务');
    const baseline = snapshot(repo);
    if (baseline.status) throw new Error('仓库有未提交改动，请先完成原任务或选择干净工作树');
    const item = { id: input.id, key: `request:${input.id}`, title: requirement.split('\n')[0].slice(0, 80), repo, requirement, digest, status: 'planning', createdAt: new Date().toISOString() };
    this.save(item);
    const work = Promise.resolve().then(async () => {
      try {
        const result = await this.plan(item, info => { Object.assign(item, info); this.save(item); });
        if (!result || !['ready', 'needs_input'].includes(result.status)) throw new Error('GPT 规划结果格式无效');
        if (result.status === 'needs_input') { item.status = 'needs_input'; item.error = result.questions || '请补充需求后重新创建'; return; }
        if (snapshot(repo).fingerprint !== baseline.fingerprint) throw new Error('规划期间代码发生变化，请重新分析；未派发 DSH');
        const task = await this.workflow.create({ repo, title: result.title, plan: result.plan });
        Object.assign(item, { taskId: task.id, title: task.title, plan: result.plan, status: 'dispatching' }); this.save(item);
        await this.workflow.start(task.id);
        item.status = 'dispatched';
      } catch (error) { item.status = 'failed'; item.error = error.message; }
      finally { this.save(item); }
    }).finally(() => this.active.delete(item.id));
    this.active.set(item.id, work);
    return item;
  }
}
