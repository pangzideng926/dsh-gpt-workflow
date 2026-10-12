import { openCodexThread } from './codex-open.mjs';
import { listWorkspaceProjects } from './workspace-projects.mjs';

export function panelHandler(store, requests, {openThread = openCodexThread, listProjects = listWorkspaceProjects} = {}) {
  return async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (req.method !== 'POST' || req.headers['x-gpt-workflow-view'] !== '1' || (origin && !['dsh-app://app', `http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin))) return reply(403, { error: '未授权' });
    try {
      if (req.url === '/gpt-workflow-view/projects') return reply(200, await listProjects());
      if (req.url === '/gpt-workflow-view/open-gpt') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024) return reply(413, {error:'请求过长'}); chunks.push(chunk); }
        const {key} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const request = requests.list().find(r => key === r.key || r.taskId && key === `${r.taskId}-1` || r.taskId && store.list().some(j => j.key === key && j.key.startsWith(`${r.taskId}-`)));
        if (!request?.gptThreadId) return reply(404, {error:'该任务尚无 GPT 会话，请等待规划开始'});
        await openThread(request.gptThreadId);
        return reply(200, {opened:true});
      }
      if (req.url === '/gpt-workflow-view/requests') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '须使用 JSON' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 65536) return reply(413, { error: '需求过长' }); chunks.push(chunk); }
        const { digest, ...item } = await requests.accept(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return reply(202, item);
      }
      if (req.url !== '/gpt-workflow-view') return reply(404, { error: '未知接口' });
      const submissions = requests.listForPanel ? requests.listForPanel() : requests.list();
      const jobs = store.list().slice(0, 100).map(({ digest, eventsPath, ...job }) => {
        const request = submissions.find(r => job.key.startsWith(`${r.taskId}-`));
        return request ? { ...job, requirement: request.requirement, gptThreadId: request.gptThreadId } : job;
      });
      const pending = submissions.filter(r => !jobs.some(j => j.key.startsWith(`${r.taskId}-`))).map(({ digest, ...item }) => item);
      return reply(200, { jobs: [...pending, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) });
    } catch (error) { return reply(409, { error: error.message }); }
  };
}
