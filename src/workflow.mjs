import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { receiverRequest } from './receiver-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}
export function snapshot(repo) {
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const branch = git(repo, 'symbolic-ref', '--short', 'HEAD').trim();
  const status = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const diff = git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--');
  const staged = git(repo, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--');
  const untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  const files = untracked.map(name => {
    const file = path.join(repo, name);
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error(`不支持未跟踪的链接或特殊文件：${name}`);
    return { path: name, bytes: st.size, sha256: hash(fs.readFileSync(file)) };
  });
  const changedFiles = [...new Set([...git(repo, 'diff', '--name-only', '-z', 'HEAD', '--').split('\0'), ...untracked].filter(Boolean))];
  const fingerprint = hash(JSON.stringify({ head, branch, status, diff, staged, files }));
  return { head, branch, status, diff, staged, untracked: files, changedFiles, fingerprint };
}
function ensurePlan(plan) {
  if (typeof plan !== 'string' || plan.length > 200000) throw new Error('实施方案必须为不超过 200000 字符的 Markdown');
  for (const title of ['目标与范围', '代码依据', '实施步骤', '验收标准', '测试要求']) {
    if (!new RegExp(`^## ${title}\\s*$`, 'm').test(plan)) throw new Error(`实施方案缺少章节：## ${title}`);
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function resolveCommand() {
  const profile = process.env.DSH_WORKFLOW_PROFILE || 'headless';
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('DSH_WORKFLOW_PROFILE 名称不合法');
  const args = ['--profile', profile, '--json', '-'];
  if (process.env.DSH_WORKFLOW_BIN) {
    const bin = fs.realpathSync(process.env.DSH_WORKFLOW_BIN);
    if (/\.m?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args] };
    if (/\.cmd$|\.bat$/i.test(bin)) throw new Error('DSH_WORKFLOW_BIN 请指定 JS 入口或可执行文件，不使用 cmd/bat 包装器');
    return { file: bin, args };
  }
  // Volta 的 Windows cmd 包装器不能被 spawn(shell:false) 直接执行。
  // 通过其已安装包的真实 JS 入口启动；不把用户任务拼接进 shell 命令。
  try {
    const shim = execFileSync('volta', ['which', 'dsh'], { encoding: 'utf8', windowsHide: true }).trim();
    const bin = path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(bin)) return { file: process.execPath, args: [bin, ...args] };
  } catch { /* 非 Volta 安装继续使用 PATH。 */ }
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(bin)) return { file: process.execPath, args: [bin, ...args] };
    }
    throw new Error('未找到 DSH JS 入口，请设置 DSH_WORKFLOW_BIN 为 @deepseek-ai/dsh/lib/bin.js 的绝对路径');
  }
  return { file: 'dsh', args };
}

export class Workflow {
  constructor(options = {}) {
    this.home = path.resolve(options.home || process.env.DSH_WORKFLOW_HOME || path.join(os.homedir(), '.codex', 'dsh-gpt-workflow'));
    this.command = options.command;
    this.timeoutMs = options.timeoutMs || Number(process.env.DSH_WORKFLOW_TIMEOUT_MS || 1800000);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 86400000) throw new Error('超时须在 1000～86400000 毫秒之间');
    fs.mkdirSync(path.join(this.home, 'tasks'), { recursive: true });
  }
  dir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('任务 ID 不合法');
    return path.join(this.home, 'tasks', id);
  }
  load(id) { return readJson(path.join(this.dir(id), 'task.json')); }
  save(task) { task.updatedAt = now(); atomicJson(path.join(this.dir(task.id), 'task.json'), task); }
  operation(id, fn) {
    const file = path.join(this.dir(id), 'operation.lock');
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error('任务正在执行另一项状态变更'); throw e; }
    try { return fn(this.load(id)); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
  }
  lockPath(repo) { return path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'dsh-gpt-workflow.lock').trim()); }
  release(task) {
    const lock = this.lockPath(task.repo);
    if (fs.existsSync(lock) && readJson(lock).id === task.id) fs.unlinkSync(lock);
  }
  async create({ repo, title, plan }) {
    ensurePlan(plan);
    if (!title?.trim()) throw new Error('任务标题不能为空');
    repo = fs.realpathSync.native(repo);
    const root = fs.realpathSync.native(git(repo, 'rev-parse', '--show-toplevel').trim());
    if (path.relative(repo, root) !== '') throw new Error('repo 必须是具体 Git 仓库根目录');
    repo = root;
    const baseline = snapshot(repo);
    if (baseline.status) throw new Error('仓库存在未提交改动；请先由原任务完成收尾，或使用独立且干净的工作树');
    const id = randomUUID();
    fs.mkdirSync(this.dir(id));
    const planPath = path.join(this.dir(id), '实施方案.md');
    fs.writeFileSync(planPath, plan, { mode: 0o600 });
    const task = { id, title: title.trim(), repo, status: 'planned', attempt: 0, createdAt: now(), planPath, planHash: hash(plan), baseline, originalHead: baseline.head, originalBranch: baseline.branch, reviews: [] };
    this.save(task);
    return this.publicTask(task);
  }
  publicTask(task) {
    const { baseline, command, planHash, ...result } = task;
    return { ...result, baselineHead: baseline.head, baselineBranch: baseline.branch };
  }
  async status(id) {
    const task = this.load(id);
    const result = this.publicTask(task);
    if (task.status === 'running') {
      result.workerAlive = alive(task.workerPid);
      if (task.backend === 'desktop') {
        try { result.receiverStatus = (await receiverRequest(`/jobs/${task.receiverKey}`)).status; }
        catch (error) { result.receiverError = error.message; }
      } else result.developerAlive = alive(task.developerPid);
      if (!result.workerAlive) result.attention = '监督进程已退出；通过 workflow_recover 核对 DSH 是否结束，锁不会自动释放';
    }
    return result;
  }
  async list() {
    return Promise.all(fs.readdirSync(path.join(this.home, 'tasks')).filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => this.status(id)));
  }
  async start(id) {
    const desktop = !this.command && !process.env.DSH_WORKFLOW_BIN;
    if (desktop) {
      const health = await receiverRequest('/health');
      if (health.protocol !== 1) throw new Error('DSH 接收插件协议不兼容');
    }
    return this.operation(id, task => {
      if (task.status !== 'planned') throw new Error(`状态 ${task.status} 不能启动开发`);
      const lock = this.lockPath(task.repo);
      if (fs.existsSync(lock)) throw new Error('仓库已被另一个任务锁定，须先完成或恢复该任务');
      if (snapshot(task.repo).fingerprint !== task.baseline.fingerprint) throw new Error('代码基线已变化，请重新分析并创建任务');
      if (hash(fs.readFileSync(task.planPath)) !== task.planHash) throw new Error('实施方案在创建后被修改，请通过修订接口更新');
      const command = desktop ? undefined : this.command || resolveCommand();
      fs.writeFileSync(lock, JSON.stringify({ id, home: this.home, createdAt: now() }), { flag: 'wx', mode: 0o600 });
      let logFd;
      try {
        task.attempt++;
        task.status = 'running'; task.command = command; task.timeoutMs = this.timeoutMs;
        task.backend = desktop ? 'desktop' : 'headless';
        task.receiverKey = desktop ? `${task.id}-${task.attempt}` : undefined;
        task.runDir = path.join(this.dir(id), 'runs', String(task.attempt));
        fs.mkdirSync(task.runDir, { recursive: true });
        fs.copyFileSync(task.planPath, path.join(task.runDir, '实施方案.md'));
        delete task.error; delete task.developerPid; delete task.workerPid; delete task.sessionId;
        this.save(task);
        logFd = fs.openSync(path.join(task.runDir, 'worker.log'), 'a');
        const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), this.home, id], {
          detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd], cwd: task.repo,
          env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        });
        if (!worker.pid) throw new Error('无法启动监督进程');
        worker.on('error', () => {}); // 失败由状态检查/恢复处理，避免后台未处理异常。
        task.workerPid = worker.pid; this.save(task); worker.unref();
      } catch (e) {
        task.status = 'failed'; task.error = e.message; this.save(task); this.release(task); throw e;
      } finally { if (logFd !== undefined) fs.closeSync(logFd); }
      return this.publicTask(task);
    });
  }
  async result(id) {
    const task = this.load(id);
    if (!['awaiting_review', 'approved', 'needs_changes', 'failed'].includes(task.status)) throw new Error(`状态 ${task.status} 尚无审查材料`);
    const evidencePath = path.join(task.runDir, 'evidence.json');
    if (!fs.existsSync(evidencePath)) return { ...this.publicTask(task), error: task.error, logPath: path.join(task.runDir, 'worker.log') };
    const evidence = readJson(evidencePath);
    return { ...this.publicTask(task), ...evidence, evidencePath, diffPath: path.join(task.runDir, 'changes.diff'), eventsPath: path.join(task.runDir, 'events.jsonl'), stderrPath: path.join(task.runDir, 'stderr.log') };
  }
  async review(id, { verdict, summary, evidenceHash }) {
    const reviewed = this.operation(id, task => {
      const previous = task.reviews.at(-1);
      if (task.status === verdict && previous?.evidenceHash === evidenceHash && previous.summary === summary) return this.publicTask(task);
      if (task.status !== 'awaiting_review') throw new Error(`状态 ${task.status} 不能提交审查结论`);
      if (!['approved', 'needs_changes'].includes(verdict) || !summary?.trim()) throw new Error('须提供审查结论与具体依据');
      const evidence = readJson(path.join(task.runDir, 'evidence.json'));
      if (!evidenceHash || evidenceHash !== evidence.evidenceHash) throw new Error('必须先读取最新审查材料并提交对应 evidenceHash');
      if (snapshot(task.repo).fingerprint !== evidence.snapshot.fingerprint) throw new Error('审查期间代码发生变化，不能按旧证据批准或驳回');
      task.reviews.push({ attempt: task.attempt, verdict, summary, evidenceHash, at: now() });
      task.status = verdict; this.save(task); this.release(task);
      return this.publicTask(task);
    });
    if (reviewed.backend === 'desktop') {
      const review = reviewed.reviews.at(-1);
      try {
        await receiverRequest(`/reviews/${reviewed.receiverKey}`, review);
        reviewed.reviewDelivery = 'delivered';
      } catch (error) { reviewed.reviewDelivery = `pending: ${error.message}；重试相同 review 参数可补发`; }
      this.operation(id, task => {
        if (task.attempt === reviewed.attempt && task.reviews.at(-1)?.evidenceHash === evidenceHash) {
          task.reviewDelivery = reviewed.reviewDelivery; this.save(task);
        }
      });
    }
    return reviewed;
  }
  async revise(id, { plan }) {
    ensurePlan(plan);
    return this.operation(id, task => {
      if (!['needs_changes', 'failed'].includes(task.status)) throw new Error(`状态 ${task.status} 不能修订`);
      if (fs.existsSync(this.lockPath(task.repo))) throw new Error('仓库仍被锁定，先恢复中断任务');
      const evidence = readJson(path.join(task.runDir, 'evidence.json'));
      const baseline = snapshot(task.repo);
      if (baseline.fingerprint !== evidence.snapshot.fingerprint) throw new Error('任务结束后代码基线又被修改，不能直接接管');
      fs.writeFileSync(task.planPath, plan, { mode: 0o600 });
      task.planHash = hash(plan); task.baseline = baseline; task.status = 'planned';
      this.save(task); return this.publicTask(task);
    });
  }
  async recover(id) {
    const initial = this.load(id);
    if (initial.backend === 'desktop') {
      if (initial.status !== 'running' || alive(initial.workerPid)) throw new Error('仅恢复监督进程已退出的 running 任务');
      const result = await receiverRequest(`/jobs/${initial.receiverKey}`);
      if (!['completed', 'failed'].includes(result.status)) throw new Error(`DSH 会话状态 ${result.status}，不能确认已安全结束，保留锁`);
      return this.operation(id, task => {
        if (task.status !== 'running' || task.receiverKey !== initial.receiverKey || alive(task.workerPid)) throw new Error('任务状态已变化');
        if (result.eventsPath) fs.copyFileSync(result.eventsPath, path.join(task.runDir, 'events.jsonl'));
        this.finish(task, result);
        return this.publicTask(task);
      });
    }
    return this.operation(id, task => {
      if (task.status !== 'running') throw new Error('仅恢复异常中断的 running 任务');
      if (alive(task.workerPid) || alive(task.developerPid)) throw new Error('监督进程或 DSH 仍在运行，不能释放锁');
      if (!task.developerPid) throw new Error('尚未记录 DSH PID，不能证明没有遗留进程；请人工核查 worker.log 与系统进程');
      this.finish(task, { exitCode: null, answer: '', error: '监督进程异常退出，已核对记录的进程不在运行' });
      return this.publicTask(task);
    });
  }
  finish(task, { exitCode, answer, error, sessionId, permissionPreset }) {
    const current = snapshot(task.repo);
    if (current.head !== task.baseline.head || current.branch !== task.baseline.branch) error = 'DSH 更改了 Git 提交或分支，需要 GPT 人工核查；' + (error || '');
    const evidence = { exitCode, answer, error: error || null, sessionId, permissionPreset, snapshot: current, changedFiles: current.changedFiles, capturedAt: now() };
    evidence.evidenceHash = hash(JSON.stringify(evidence));
    atomicJson(path.join(task.runDir, 'evidence.json'), evidence);
    fs.writeFileSync(path.join(task.runDir, 'changes.diff'), current.diff);
    task.status = exitCode === 0 && !error ? 'awaiting_review' : 'failed';
    task.error = error || null; task.sessionId = sessionId; task.finishedAt = now();
    this.save(task);
    if (task.status === 'failed') this.release(task);
  }
}
