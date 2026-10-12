import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReceiverStore } from '../src/receiver-store.mjs';
import { serveReceiver } from '../src/receiver-http.mjs';
const request = { id: '12345678-1234-1234-1234-123456789abc', attempt: 1, repo: 'fixture', title: '开发', prompt: '测试', baseline: 'abc', timeoutMs: 1000 };
test('并发重复投递只创建一个 DSH 会话', async () => {
  let count = 0;
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => { count++; await new Promise(r => setTimeout(r, 20)); return { answer: '完成' }; });
  const [a, b] = await Promise.all([store.accept(request), store.accept(request)]);
  assert.equal(count, 1);
  assert.equal(a.sessionId, b.sessionId);
});
test('同一任务轮次不能被不同内容替换', async () => {
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => ({ answer: '完成' }));
  await store.accept(request);
  await assert.rejects(store.accept({ ...request, prompt: '篡改' }), /内容不一致/);
});
test('重启后的未知运行状态不会重放任务或伪装完成', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-'));
  const first = new ReceiverStore(home, () => new Promise(() => {}));
  const job = await first.accept(request);
  let called = false;
  const restarted = new ReceiverStore(home, async () => { called = true; });
  assert.equal((await restarted.accept(request)).status, 'interrupted');
  assert.equal(restarted.get(job.key).sessionId, job.sessionId);
  assert.equal(called, false);
});
test('已完成任务重启后返回原结果，开发失败单独标记', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-'));
  const store = new ReceiverStore(home, async () => ({ answer: '完成', exitCode: 0 }));
  const job = await store.accept(request); await store.active.get(job.key);
  const restored = new ReceiverStore(home, () => { throw new Error('不应重放'); });
  assert.equal((await restored.accept(request)).answer, '完成');
  assert.equal(restored.get(job.key).status, 'completed');
  const failed = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => ({ error: '模型失败', exitCode: 1 }));
  const bad = await failed.accept(request); await failed.active.get(bad.key);
  assert.equal(failed.get(bad.key).status, 'failed');
});
test('未确认会话空闲的异常保留为 interrupted', async () => {
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => { throw new Error('连接中断'); });
  const job = await store.accept(request); await store.active.get(job.key);
  assert.equal(store.get(job.key).status, 'interrupted');
});
test('非零退出码即使没有 error 也不得接收通过结论', async () => {
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => ({ answer: '自称完成', exitCode: 1 }));
  const job = await store.accept(request); await store.active.get(job.key);
  assert.equal(store.get(job.key).status, 'failed');
  assert.throws(() => store.review(job.key, { verdict: 'approved', summary: '错误批准', evidenceHash: 'a'.repeat(64) }), /仅开发完成/);
});
test('本地 HTTP 拒绝无令牌与浏览器来源，只接收鉴权后的任务', async () => {
  let count = 0;
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => { count++; return { answer: '完成', exitCode: 0 }; });
  const { server, url } = await serveReceiver(store, 'test-secret');
  try {
    assert.equal((await fetch(url + '/health')).status, 403);
    const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/health', { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await (await fetch(url + '/health', { headers })).json()).mode, 'desktop');
    const a = await (await fetch(url + '/jobs', { method: 'POST', headers, body: JSON.stringify(request) })).json();
    const b = await (await fetch(url + '/jobs', { method: 'POST', headers, body: JSON.stringify(request) })).json();
    assert.equal(a.sessionId, b.sessionId); assert.equal(count, 1);
    assert.equal((await fetch(url + '/jobs', { method: 'POST', headers, body: JSON.stringify({ ...request, prompt: '不同' }) })).status, 409);
    assert.throws(() => store.get('../outside'), /不合法/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('审查只接受完成轮次，结论可幂等补发但不能篡改', async () => {
  const store = new ReceiverStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receiver-')), async () => ({ answer: '完成', exitCode: 0 }));
  const job = await store.accept(request); await store.active.get(job.key);
  const review = { verdict: 'approved', summary: '已核对证据', evidenceHash: 'a'.repeat(64) };
  assert.equal(store.review(job.key, review).review.verdict, 'approved');
  assert.equal(store.review(job.key, review).review.verdict, 'approved');
  assert.throws(() => store.review(job.key, { ...review, verdict: 'needs_changes' }), /不同审查/);
  assert.throws(() => store.review(job.key, { ...review, evidenceHash: '' }), /不合法/);
});
