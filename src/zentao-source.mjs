import { createHash } from 'node:crypto';
import { requestTaskIds } from './workspace-selection.mjs';

export function normalizeZentaoSource(value) {
  if (!value || value.provider !== 'zentao' || !['task','bug','story'].includes(value.kind)) throw new Error('禅道来源类别无效');
  if (typeof value.server !== 'string' || value.server.length > 2000) throw new Error('禅道服务器地址无效');
  let url;
  try { url = new URL(value.server); } catch { throw new Error('禅道服务器地址无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('禅道服务器须为不含凭据、查询和片段的 HTTP 地址');
  const id = String(value.id);
  if (!/^[1-9][0-9]{0,15}$/.test(id)) throw new Error('禅道来源编号无效');
  const server = url.href.replace(/\/+$/, '');
  return {provider:'zentao', server, kind:value.kind, id, title:typeof value.title === 'string' ? value.title.slice(0,200) : '', url:`${server}/${value.kind}-view-${id}.html`};
}

// 身份不包含标题、需求内容或工作区，网络重试/刷新后仍回到原记录。
export function zentaoRequestId(source) {
  const s=normalizeZentaoSource(source);
  const hex=createHash('sha256').update(JSON.stringify([s.provider,s.server,s.kind,s.id])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function zentaoProgress(request, workflow, jobs) {
  const tasks=requestTaskIds(request).map(id=>{
    try {
      const task=workflow.load(id);
      const key=`${id}-${task.attempt}`;
      const job=jobs.find(j=>j.key===key);
      let status=({planned:'dispatching',awaiting_review:'completed'})[task.status] || task.status;
      // 当前轮次的失败与完成可先于监督进程回写；旧轮次审查不能覆盖新轮次。
      if (status==='running' && job) status=job.status==='completed' ? 'completed' : job.status;
      return {id,key:task.status==='planned' || !job ? request.key : key,status,repo:task.repo,error:task.error || job?.error};
    } catch { return {id,key:request.key,status:'interrupted',error:'关联任务缺失，请核对原记录'}; }
  });
  let status=request.archivedAt ? 'archived' : request.status;
  if (!request.archivedAt && tasks.length && !['failed','interrupted'].includes(status)) {
    const states=tasks.map(t=>t.status);
    status=states.every(s=>s==='approved') ? 'approved' : ['failed','interrupted','needs_changes','dispatching','accepted','running','completed'].find(s=>states.includes(s)) || 'interrupted';
  }
  return {requestId:request.id,key:tasks.find(t=>t.status!=='approved')?.key || tasks[0]?.key || request.key,source:request.source,status,title:request.title,workspace:request.workspace,repo:request.repo,error:request.error || tasks.find(t=>t.error)?.error,tasks};
}
