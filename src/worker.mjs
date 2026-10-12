import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Workflow } from './workflow.mjs';
import { receiverRequest } from './receiver-client.mjs';

const workflow = new Workflow({ home: process.argv[2] });
const task = workflow.load(process.argv[3]);
let child;
try {
  const plan = fs.readFileSync(path.join(task.runDir, '实施方案.md'), 'utf8');
  const prompt = `你是本次任务唯一的代码开发者。GPT 已制定以下实施方案，完成后由 GPT 审查。
目标仓库：${task.repo}
起始分支：${task.baseline.branch}；起始提交：${task.baseline.head}
先读取适用的 AGENTS.md 和方案引用的规范。只在目标仓库实现本次需求，保留已有内容。
本次明确分工：你只开发和运行必要测试；Git add/commit/push、切分支、拉取等收尾由 GPT 审查通过后统一执行，本轮不要执行。不要修改插件任务状态或审查证据。
涉及关键逻辑先写能暴露错误的测试，确认失败后实现通过。不自动派发子代理。
实现细节可自行决定；需求、接口或数据结构需要实质变更时停止，说明原因交回 GPT 更新方案。
最终用简体中文报告：已改文件、各项验收结果、实际测试命令与退出码、未运行项及阻塞。不得把“没有运行”写成通过。
上一轮审查意见：${task.reviews.at(-1)?.summary || '无'}

${plan}`;
  fs.writeFileSync(path.join(task.runDir, 'prompt.md'), prompt, { mode: 0o600 });
  if (task.backend === 'desktop') {
    const request = { id: task.id, attempt: task.attempt, repo: task.repo, title: task.title, prompt, plan, baseline: task.baseline.fingerprint, timeoutMs: task.timeoutMs };
    // 重试时使用同一轮次和完全相同的内容；接收方负责持久化去重。
    let result;
    for (let n = 0; n < 3; n++) {
      try { result = await receiverRequest('/jobs', request); break; }
      catch (error) { if (n === 2) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
    task.sessionId = result.sessionId; task.workerPid = process.pid; workflow.save(task);
    const deadline = Date.now() + task.timeoutMs + 60000;
    while (!['completed', 'failed'].includes(result.status)) {
      if (result.status === 'interrupted') throw new Error(result.error);
      if (Date.now() > deadline) throw new Error('接收插件未确认会话停止，保留仓库锁；稍后调用 recover');
      await new Promise(r => setTimeout(r, 1500));
      result = await receiverRequest(`/jobs/${task.receiverKey}`);
    }
    if (result.eventsPath) fs.copyFileSync(result.eventsPath, path.join(task.runDir, 'events.jsonl'));
    workflow.finish(task, result);
  } else {
  child = spawn(task.command.file, task.command.args, {
    cwd: task.repo, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let timedOut = false, finalSeen = false, answer = '', error = '', sessionId;
  task.workerPid = process.pid; task.developerPid = child.pid; workflow.save(task);
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { child.kill('SIGKILL'); }
  }, task.timeoutMs);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    if (stderrBytes < 256000) fs.appendFileSync(path.join(task.runDir, 'stderr.log'), chunk.subarray(0, 256000 - stderrBytes));
    stderrBytes += chunk.length;
  });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { error = 'DSH stdout 含非 JSON 输出，请核对当前 headless 版本'; return; }
    if (event.type === 'thinking') return;
    fs.appendFileSync(path.join(task.runDir, 'events.jsonl'), JSON.stringify(event) + '\n');
    if (event.type === 'session') sessionId = event.sessionId;
    if (event.type === 'error') error = event.message || 'DSH 返回 error 事件';
    if (event.type === 'final') { finalSeen = true; answer = typeof event.text === 'string' ? event.text : ''; }
  });
  child.stdin.on('error', e => { if (e.code !== 'EPIPE') error = e.message; });
  const outcome = new Promise(resolve => {
    child.on('error', e => { error = e.message; });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(prompt);
  const { code, signal } = await outcome;
  clearTimeout(timer);
  if (timedOut) error = 'DSH 执行超时，已终止本次进程树';
  else if (code !== 0) error ||= `DSH 退出码 ${code}，信号 ${signal || '无'}；请读取 stderr.log`;
  else if (!finalSeen || !answer.trim()) error ||= 'DSH 缺少非空 final 结果';
  workflow.finish(task, { exitCode: code, answer, error, sessionId });
  }
} catch (e) {
  // 无法完成证据采集时保持锁，禁止后续任务接管仍可能活动的进程。
  console.error(e.stack);
  process.exitCode = 1;
}
