import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicJson, snapshot } from './workflow.mjs';
import { requestTaskIds } from './workspace-selection.mjs';
import { normalizeZentaoSource, zentaoRequestId } from './zentao-source.mjs';

function resolveTarget(workspace, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('GPT 返回的仓库路径无效');
  const repo = fs.realpathSync.native(candidate), relative = path.relative(workspace, repo);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('GPT 识别的仓库不在所选工作区内');
  const marker = path.join(repo, '.git');
  let gitDir = marker;
  if (!fs.existsSync(marker)) throw new Error('GPT 识别的目标不是 Git 仓库根目录');
  if (fs.statSync(marker).isFile()) {
    const match = /^gitdir: (.+)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
    if (!match) throw new Error('Git worktree 标记无效');
    gitDir = path.resolve(repo, match[1].trim());
  }
  // 工作区根目录的空 .git/hooks 不是仓库，不在其上运行 Git。
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) throw new Error('GPT 识别的目标不是 Git 仓库根目录');
  const root = fs.realpathSync.native(execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding:'utf8', windowsHide:true }).trim());
  if (path.relative(repo, root)) throw new Error('GPT 识别的目标不是 Git 仓库根目录');
  return repo;
}

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
      if (item.status !== 'dispatched' || !requestTaskIds(item).length) return item;
      try { const task = requestTaskIds(item).map(id=>this.workflow.load(id)).find(t=>t.status==='failed'); return task ? { ...item, status: 'failed', error: task.error || 'DSH 启动或开发失败，请核对任务' } : item; }
      catch { return { ...item, status: 'interrupted', error: '无法读取已派发任务，请核对任务记录' }; }
    });
  }
  async accept(input) {
    if (input.source !== undefined) {
      const source=normalizeZentaoSource(input.source), id=zentaoRequestId(source);
      if (fs.existsSync(this.file(id))) {
        const old=this.get(id);
        if (!old.source || zentaoRequestId(old.source)!==id) throw new Error('禅道关联记录冲突，请核对原请求');
        return old;
      }
      return this.acceptWorkspace({...input,id,source});
    }
    if (input.workspace !== undefined) return this.acceptWorkspace(input);
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
    const root = resolveTarget(repo, repo);
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

  async acceptWorkspace(input) {
    this.file(input.id);
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('请提供工作区绝对路径');
    if (typeof input.requirement !== 'string' || !input.requirement.trim() || input.requirement.length > 20000) throw new Error('需求不能为空且不能超过 20000 字符');
    const workspace = fs.realpathSync.native(input.workspace);
    if (!fs.statSync(workspace).isDirectory()) throw new Error('工作区必须是目录');
    const requirement = input.requirement.trim();
    const digest = createHash('sha256').update(JSON.stringify({ workspace, requirement, source:input.source })).digest('hex');
    if (fs.existsSync(this.file(input.id))) {
      const old = this.get(input.id);
      if (old.digest !== digest) throw new Error('同一请求 ID 内容不一致');
      return old;
    }
    if (this.list().some(j => j.workspace === workspace && ['planning','dispatching','interrupted'].includes(j.status))) throw new Error('该工作区已有规划或待核查请求，请先处理原任务');
    const item = { source:input.source, id:input.id, key:`request:${input.id}`, title:requirement.split('\n')[0].slice(0,80), workspace, repo:workspace, requirement, digest, status:'planning', stage:'locate', createdAt:new Date().toISOString() };
    this.save(item);
    const update = info => { Object.assign(item, info); this.save(item); };
    const work = Promise.resolve().then(async()=>{
      try {
        const checkAvailable = repo => {
          if (this.list().some(j=>j.id!==item.id && ['planning','dispatching','interrupted'].includes(j.status) && (j.repo===repo || j.repos?.includes(repo)))) throw new Error(`该仓库已有规划或待核查请求：${repo}`);
          if (fs.existsSync(this.workflow.lockPath(repo))) throw new Error(`该仓库已有开发/审查任务：${repo}`);
        };
        let scopeError;
        const inspectScope = located => {
          try {
            if (!Array.isArray(located.repos) || !located.repos.length || located.repos.length>8) throw new Error('GPT 未返回明确的执行仓库范围（最多 8 个）');
            const targets=located.repos.map(repo=>resolveTarget(workspace,repo));
            if (new Set(targets).size!==targets.length) throw new Error('GPT 返回了重复仓库');
            for (const repo of targets) {
              checkAvailable(repo);
              if (snapshot(repo).status) throw new Error(`仓库有未提交改动：${repo}，请先完成原任务或使用干净工作树`);
            }
          } catch(error) { scopeError=error; throw error; }
        };
        // 先将只读预检查反馈给 GPT，使本回合 Markdown 能说明真实暂停原因。
        const located = await this.plan(item, update, inspectScope);
        if (scopeError) throw scopeError;
        if (located?.status === 'needs_input') { item.status='needs_input'; item.error=located.questions || '请补充功能范围，GPT 尚无法定位相关代码'; return; }
        if (located?.status !== 'ready' || !Array.isArray(located.repos) || !located.repos.length || located.repos.length>8) throw new Error('GPT 未返回明确的执行仓库范围（最多 8 个）');
        const repos = located.repos.map(repo=>resolveTarget(workspace,repo));
        if (new Set(repos).size !== repos.length) throw new Error('GPT 返回了重复仓库');
        item.repos=repos; item.stage='plan'; item.repo=repos.length===1 ? repos[0] : workspace; item.scopeReason=located.reason;
        this.save(item);
        const baselines = new Map();
        for (const repo of repos) {
          checkAvailable(repo); const baseline=snapshot(repo);
          if (baseline.status) throw new Error(`仓库有未提交改动：${repo}，请先完成原任务或使用干净工作树`);
          baselines.set(repo,baseline);
        }
        const result = await this.plan(item, update);
        if (result?.status === 'needs_input') { item.status='needs_input'; item.error=result.questions || '请补充需求'; item.plan=result.plan; return; }
        if (result?.status !== 'ready' || !Array.isArray(result.tasks) || result.tasks.length!==repos.length) throw new Error('GPT 实施方案与识别的仓库范围不一致');
        const tasks=result.tasks.map(task=>({...task,repo:resolveTarget(workspace,task.repo)}));
        if (new Set(tasks.map(t=>t.repo)).size!==repos.length || tasks.some(t=>!baselines.has(t.repo))) throw new Error('GPT 实施方案改变了已识别的仓库范围');
        const checkBaselines = () => {
          for(const repo of repos) {
            checkAvailable(repo);
            if(snapshot(repo).fingerprint!==baselines.get(repo).fingerprint) throw new Error('规划期间代码发生变化，请重新分析；未派发 DSH');
          }
        };
        checkBaselines();
        item.title=result.title || item.title; item.taskIds=[]; item.stage='dispatch';
        item.plan=tasks.map(t=>`# ${t.title}\n\n仓库：${t.repo}\n\n${t.plan}`).join('\n\n---\n\n'); this.save(item);
        for (const task of tasks) {
          const created=await this.workflow.create(task);
          item.taskIds.push(created.id); item.taskId=item.taskIds[0]; this.save(item);
        }
        checkBaselines(); item.status='dispatching'; this.save(item);
        for (const id of item.taskIds) await this.workflow.start(id);
        item.status='dispatched';
      } catch(error) { item.status='failed'; item.error=error.message + (item.taskIds?.length ? '；已关联的任务记录保留，请核对各任务状态，不会自动重放' : ''); }
      finally {this.save(item);}
    }).finally(()=>this.active.delete(item.id));
    this.active.set(item.id,work);
    return item;
  }
}
