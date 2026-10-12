import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Workflow } from './workflow.mjs';
import { receiverRequest } from './receiver-client.mjs';
import { createHandoff, developerPrompt } from './handoff.mjs';

const workflow = new Workflow({ home: process.argv[2] });
const task = workflow.load(process.argv[3]);
let child;
try {
  const plan = fs.readFileSync(path.join(task.runDir, '实施方案.md'), 'utf8');
  const packetPath = path.join(task.runDir, 'handoff.json');
  const handoff = fs.existsSync(packetPath) ? JSON.parse(fs.readFileSync(packetPath, 'utf8')) : createHandoff(task, plan);
  const prompt = developerPrompt(task, plan, handoff);
  fs.writeFileSync(path.join(task.runDir, 'prompt.md'), prompt, { mode: 0o600 });
  if (task.backend === 'desktop') {
    // plan 已随请求传输；接收端按需提取章节，避免交接包再次复制整份方案。
    const { sections, ...handoffMetadata } = handoff;
    const request = { id: task.id, attempt: task.attempt, repo: task.repo, title: task.title, prompt, plan, handoff: handoffMetadata, baseline: task.baseline.fingerprint, timeoutMs: task.timeoutMs };
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
