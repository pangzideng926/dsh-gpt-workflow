import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReceiverStore } from './receiver-store.mjs';
import { serveReceiver } from './receiver-http.mjs';
import { receiverHome } from './receiver-client.mjs';
import { atomicJson, snapshot, Workflow } from './workflow.mjs';
import { QuickRequests } from './quick-requests.mjs';
import { createPlanner } from './codex-planner.mjs';
import { panelHandler } from './panel-api.mjs';

export const name = 'gpt-workflow-receiver';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'workspaceRegistry', 'permissionPresets', 'sessionTitle', 'sessions'];

export async function executeJob(ctx, request, job, home) {
  if (snapshot(request.repo).fingerprint !== request.baseline) return { error: 'DSH 接单时仓库基线已变化', exitCode: 1 };
  ctx.permissionPresets.resolve('workspace-write');
  const preset = await ctx.agentPresets.resolve();
  const scope = await ctx.agentPresets.acquireScope(preset.id);
  let agent, timer, handle, submitted = false;
  try {
    const workspace = await ctx.workspaceRegistry.create(request.repo);
    const selection = ctx.agentDefaultModel.currentSelection();
    handle = await ctx.agents.create({
      sessionId: job.sessionId, meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, preset.id);
        agentCtx.on('agent/request', async ({ agent: subject }, next) => {
          const resolved = await next();
          if (subject.session.requestHeader() !== undefined || resolved.provider !== selection.provider || resolved.model !== selection.model) return resolved;
          const { reasoningEffort: ignored, ...rest } = resolved;
          return { ...rest, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
        });
      },
    });
    agent = handle.agent;
    await workspace.attachSession(job.sessionId);
    ctx.permissionPresets.set(agent.session, 'workspace-write');
    ctx.sessionTitle.rename(agent.session, `GPT 开发 · ${request.title} · 第 ${request.attempt} 轮`);
    const firstSeq = agent.session.seq;
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; agent.cancel({ kind: 'user' }); }, request.timeoutMs);
    submitted = true;
    agent.followup(Object.freeze({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request.prompt }] }));
    await agent.whenIdle();
    clearTimeout(timer);
    await ctx.sessions.flush(agent.session);
    const events = []; let answer = '', reason;
    for (let seq = firstSeq; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(seq);
      if (!event) throw new Error(`无法读取 DSH 会话事件 ${seq}`);
      if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (text) answer = text;
        events.push({ type: 'text', text });
      } else if (event.type === 'tool/call') events.push({ type: 'tool_call', ...event.data });
      else if (event.type === 'tool/result') events.push({ type: 'tool_result', ...event.data });
      else if (event.type === 'turn/end') { reason = event.data.reason; events.push({ type: 'turn_end', reason }); }
    }
    const eventsPath = path.join(home, `${job.key}.jsonl`);
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    const error = timedOut ? 'DSH 开发超时，已取消并等待会话空闲' : reason?.kind !== 'completed' ? `DSH 未正常完成：${JSON.stringify(reason)}` : !answer.trim() ? 'DSH 缺少最终报告' : null;
    return { answer, eventsPath, error, exitCode: error ? 1 : 0, permissionPreset: ctx.permissionPresets.current(agent.session) };
  } catch (error) {
    if (submitted) throw error;
    if (handle) await handle.dispose();
    return { error: error.message, exitCode: 1 };
  } finally {
    clearTimeout(timer);
    await scope[Symbol.asyncDispose]();
  }
}

export async function apply(ctx) {
  const home = receiverHome(); fs.mkdirSync(home, { recursive: true });
  const store = new ReceiverStore(path.join(home, 'jobs'), (request, job) => executeJob(ctx, request, job, home));
  const abort = new AbortController();
  const requests = new QuickRequests(path.join(home, 'requests'), { workflow: new Workflow(), plan: createPlanner(path.join(home, 'planning'), abort.signal) });
  ctx.on('dispose', () => abort.abort());
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/gpt-workflow-view', handler: panelHandler(store, requests) }), 'gpt-workflow-receiver: panel');
  });
  const token = randomBytes(32).toString('hex');
  const { server, url } = await serveReceiver(store, token);
  const connectionFile = path.join(home, 'connection.json');
  atomicJson(connectionFile, { protocol: 1, url, token, pid: process.pid });
  ctx.on('dispose', () => {
    server.close();
    try { if (JSON.parse(fs.readFileSync(connectionFile, 'utf8')).token === token) fs.unlinkSync(connectionFile); } catch { /* 已关闭 */ }
  });
}
