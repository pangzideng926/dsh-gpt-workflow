import { TaskActions } from './task-actions.mjs';
import { openCodexThread } from './codex-open.mjs';
import { listWorkspaceProjects } from './workspace-projects.mjs';
import { listCodexWorkspaces } from './codex-workspaces.mjs';
import { ownsJob, requestTaskIds } from './workspace-selection.mjs';
import { normalizeZentaoSource, zentaoRequestId, zentaoProgress } from './zentao-source.mjs';

export function panelHandler(store, requests, {openThread = openCodexThread, listProjects = listWorkspaceProjects, listWorkspaces = listCodexWorkspaces} = {}) {
  const actions = new TaskActions(requests,store);
  const enrich = item => ({...item,...actions.describe(item.key)});
  return async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const origin = req.headers.origin;
    if (req.method !== 'POST' || req.headers['x-gpt-workflow-view'] !== '1' || (origin && !['dsh-app://app', `http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin))) return reply(403, { error: '未授权' });
    try {
      if (req.url === '/gpt-workflow-view/actions') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415,{error:'须使用 JSON'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>16384)return reply(413,{error:'操作请求过长'});chunks.push(chunk);}
        return reply(200,await actions.perform(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }
      if (['/gpt-workflow-view/zentao-links','/gpt-workflow-view/linked'].includes(req.url)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415,{error:'须使用 JSON'});
        const chunks=[]; let size=0;
        for await (const chunk of req) { size+=chunk.length; if(size>16384)return reply(413,{error:'查询过长'}); chunks.push(chunk); }
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const allJobs=store.list();
        if (req.url.endsWith('/zentao-links')) {
          if (!Array.isArray(body.items) || body.items.length>100) throw new Error('一次最多查询100个禅道条目');
          const ids=new Set(body.items.map(item=>zentaoRequestId(normalizeZentaoSource({provider:'zentao',server:body.server,kind:item.kind,id:item.id}))));
          const links=requests.list().filter(r=>r.source?.provider==='zentao' && ids.has(zentaoRequestId(r.source))).map(r=>zentaoProgress(r,requests.workflow,allJobs));
          return reply(200,{links});
        }
        const request=requests.get(body.requestId);
        if (request.source?.provider!=='zentao') throw new Error('不是禅道关联请求');
        const progress=zentaoProgress(request,requests.workflow,allJobs);
        const {digest,...summary}=request;
        const jobs=allJobs.filter(job=>ownsJob(request,job.key)).map(({digest,eventsPath,...job})=>({...job,source:request.source,requestId:request.id,requirement:request.requirement,gptThreadId:request.gptThreadId,workspace:request.workspace}));
        return reply(200,{workspaceRequests:true,zentaoRequests:true,focusKey:progress.tasks.length===1 ? progress.key : request.key,jobs:[{...summary,status:progress.status,error:progress.error},...jobs.map(job=>({...job,archivedAt:request.archivedAt}))].map(enrich)});
      }
      if (req.url === '/gpt-workflow-view/projects') return reply(200, await listProjects());
      if (req.url === '/gpt-workflow-view/workspaces') return reply(200, await listWorkspaces());
      if (req.url === '/gpt-workflow-view/open-gpt') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024) return reply(413, {error:'请求过长'}); chunks.push(chunk); }
        const {key} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const request = requests.list().find(r => key === r.key || ownsJob(r,key));
        if (!request?.gptThreadId) return reply(404, {error:'该任务尚无 GPT 会话，请等待规划开始'});
        if (request.status === 'planning' || ['starting','owned','release_failed'].includes(request.gptSessionState)) return reply(409, {error:'GPT 规划进程仍占用此会话，请先在 DSH 面板查看进展，待规划结束并释放后再打开。'});
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
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024)return reply(413,{error:'查询过长'});chunks.push(chunk);}
      const {view='active',offset=0}=chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if(!['active','archived'].includes(view) || !Number.isSafeInteger(offset) || offset<0) throw new Error('列表分页参数无效');
      const submissions = requests.listForPanel ? requests.listForPanel() : requests.list();
      const jobs = store.list().map(({ digest, eventsPath, ...job }) => {
        const request = submissions.find(r => ownsJob(r,job.key));
        return request ? { ...job, archivedAt:request.archivedAt, requirement: request.requirement, gptThreadId: request.gptThreadId, workspace:request.workspace, source:request.source, requestId:request.id } : job;
      });
      const pending = submissions.filter(r => r.archivedAt || r.actionRevision || !requestTaskIds(r).length || !requestTaskIds(r).every(id=>jobs.some(j=>j.key.startsWith(`${id}-`))) || ['failed','interrupted'].includes(r.status)).map(({ digest, ...item }) => ({...item,status:zentaoProgress(item,requests.workflow,store.list()).status}));
      const visible=[...pending,...jobs].map(enrich).filter(job=>view==='archived' ? !!job.archivedAt : !job.archivedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return reply(200,{workspaceRequests:true,zentaoRequests:true,jobs:visible.slice(offset,offset+100),hasMore:visible.length>offset+100,nextOffset:offset+100});
    } catch (error) { return reply(409, { error: error.message }); }
  };
}
