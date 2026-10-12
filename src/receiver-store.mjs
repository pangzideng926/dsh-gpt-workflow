import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson } from './workflow.mjs';
export function jobKey(id, attempt) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(attempt) || attempt < 1) throw new Error('任务标识不合法');
  return `${id}-${attempt}`;
}
export class ReceiverStore {
  constructor(home, run) {
    this.home = home; this.run = run; this.active = new Map();
    fs.mkdirSync(home, { recursive: true });
    // 宿主重启后不能确认旧轮次是否执行完；保留证据并拒绝隐式重放。
    for (const file of fs.readdirSync(home).filter(f => f.endsWith('.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(home, file), 'utf8'));
      if (['accepted', 'running'].includes(job.status)) {
        job.status = 'interrupted'; job.error = 'DSH 宿主重启，需人工核对原会话；不会重复派单'; this.save(job);
      }
    }
  }
  file(key) { if (!/^[0-9a-f-]{36}-\d+$/.test(key)) throw new Error('任务标识不合法'); return path.join(this.home, `${key}.json`); }
  save(job) { atomicJson(this.file(job.key), job); }
  get(key) { return JSON.parse(fs.readFileSync(this.file(key), 'utf8')); }
  list() { return fs.readdirSync(this.home).filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  review(key, review) {
    const job = this.get(key);
    if (job.status !== 'completed') throw new Error('仅开发完成的任务可接收 GPT 审查');
    if (!['approved', 'needs_changes'].includes(review.verdict) || !review.summary?.trim() || !/^[0-9a-f]{64}$/.test(review.evidenceHash)) throw new Error('审查内容不合法');
    if (job.review && JSON.stringify(job.review) !== JSON.stringify(review)) throw new Error('本轮已有不同审查结论');
    job.review = review; this.save(job); return job;
  }
  async accept(request) {
    const key = jobKey(request.id, request.attempt);
    for (const field of ['repo', 'title', 'prompt', 'baseline']) if (typeof request[field] !== 'string' || !request[field]) throw new Error(`缺少 ${field}`);
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 86400000) throw new Error('超时不合法');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (fs.existsSync(this.file(key))) {
      const old = this.get(key);
      if (old.digest !== digest) throw new Error('同一任务轮次内容不一致');
      return old;
    }
    const job = { key, digest, sessionId: `gpt-${randomUUID()}`, status: 'accepted', title: request.title, repo: request.repo, plan: request.plan || request.prompt, createdAt: new Date().toISOString() };
    this.save(job); // 第一个 await 之前落盘；中途崩溃也不重放。
    const work = Promise.resolve().then(async () => {
      job.status = 'running'; this.save(job);
      try {
        const result = await this.run(request, job);
        Object.assign(job, result, { status: result.error || result.exitCode !== 0 ? 'failed' : 'completed' });
      } catch (error) {
        job.status = 'interrupted'; job.error = error.message; // 未证明 agent idle 时不释放 GPT 仓库锁。
      }
      job.finishedAt = new Date().toISOString(); this.save(job);
    }).finally(() => this.active.delete(key));
    this.active.set(key, work);
    return job;
  }
}
