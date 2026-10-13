import fs from 'node:fs';
import {requestTaskIds, ownsJob} from './workspace-selection.mjs';

function alive(pid) {
  if (!Number.isInteger(pid) || pid<=0) return false;
  try {process.kill(pid,0);return true;} catch(error) {return error.code!=='ESRCH';}
}

// 所有按钮走同一入口；归档仅保存标记，绝不删除任务、证据或代码。
export class TaskActions {
  constructor(requests,store) {this.requests=requests;this.workflow=requests.workflow;this.store=store;this.busy=new Set();}
  target(key) {
    if (typeof key!=='string') throw new Error('任务标识无效');
    const request=this.requests.list().find(r=>r.key===key || ownsJob(r,key));
    if (request) {
      const tasks=requestTaskIds(request).map(id=>this.workflow.load(id));
      if (key!==request.key && !tasks.some(t=>`${t.id}-${t.attempt}`===key)) throw new Error('这是历史轮次，请在当前任务操作');
      return {request,tasks,root:request,key:request.key};
    }
    const match=/^([0-9a-f-]{36})-(\d+)$/.exec(key);
    if (!match) throw new Error('任务不存在');
    const task=this.workflow.load(match[1]);
    if (task.attempt!==Number(match[2])) throw new Error('这是历史轮次，请在当前任务操作');
    return {tasks:[task],root:task,key};
  }
  describe(key) {
    try {
      const t=this.target(key),archivedAt=t.root.archivedAt;
      const states=t.tasks.map(task=>task.status);
      const active=this.requests.active?.has(t.request?.id) || states.some(s=>s==='running');
      const actions=archivedAt ? ['restore'] : active ? ['recover'] : [
        ...(['failed','interrupted'].includes(t.request?.status) || states.includes('failed') ? ['recover'] : []),
        ...(states.some(s=>['failed','planned'].includes(s)) || !states.length && t.request?.status==='failed' ? ['retry'] : []),
        ...(!states.some(s=>['running','awaiting_review'].includes(s)) && !['planning','dispatching'].includes(t.request?.status) ? ['archive'] : []),
      ];
      return {actionVersion:JSON.stringify([t.root.updatedAt,t.root.actionRevision||0,states,t.tasks.map(s=>[s.id,s.attempt,s.updatedAt,s.archivedAt])]),availableActions:actions,archivedAt};
    } catch(error) {return {availableActions:[],actionError:error.message};}
  }
  checkPlanning(request,action) {
    if (!request) return;
    if (this.requests.active.has(request.id)) throw new Error('GPT 规划或派发仍在执行，请等待结束');
    if (request.gptSessionState==='released') return;
    if (request.status==='interrupted' || request.gptThreadId || ['starting','owned','release_failed'].includes(request.gptSessionState)) {
      if (action!=='recover') throw new Error('GPT 会话尚未确认释放，请先异常恢复');
      if (!Number.isInteger(request.gptPid) || request.gptPid<=0) throw new Error('旧记录缺少 GPT 进程退出证据，不能自动证明释放；请在原会话核查');
      if (alive(request.gptPid)) throw new Error('GPT 规划进程仍在运行，不能强行释放');
      // 只在恢复入口保存释放证据，其他操作不可隐式清除占用。
      request.gptSessionState='released';this.requests.save(request);
    }
  }
  checkTask(task,{recover=false,locks=true}={}) {
    if ([...this.store.active.keys()].some(key=>key.startsWith(`${task.id}-`))) throw new Error('DSH 本地执行仍在进行');
    if (alive(task.workerPid) || alive(task.developerPid)) throw new Error('监督进程或 DSH 仍在运行');
    const job=this.store.list().find(j=>j.key===`${task.id}-${task.attempt}`);
    if (job && ['accepted','running','interrupted'].includes(job.status)) throw new Error(`DSH 会话状态 ${job.status}，未证明空闲，保留任务与锁`);
    if (task.status==='running' && !recover) throw new Error('运行状态需要先异常恢复');
    if (locks && fs.existsSync(this.workflow.lockPath(task.repo))) throw new Error('仓库仍有开发/审查锁，不能重试或归档');
  }
  async perform({key,action,version}) {
    if (!['recover','retry','archive','restore'].includes(action)) throw new Error('未知任务操作');
    let t=this.target(key);
    if (this.busy.has(t.key)) throw new Error('任务正在执行另一项操作');
    const view=this.describe(key);
    if (!version || version!==view.actionVersion) throw new Error('任务状态已变化，请刷新后重试');
    if (t.root.archivedAt && action!=='restore') throw new Error('任务已归档，请先恢复显示');
    this.busy.add(t.key);
    try {
      this.checkPlanning(t.request,action);
      t.root.actionRevision=(t.root.actionRevision||0)+1;
      if(t.request)this.requests.save(t.root);else this.workflow.save(t.root);
      if (action==='recover') {
        for (const task of t.tasks) {
          this.checkTask(task,{recover:true,locks:false});
          if (task.status==='running') await this.workflow.recover(task.id);
        }
        t=this.target(key);
        if (t.request) {
          t.request.status=t.tasks.length && !t.tasks.some(task=>task.status==='failed') ? 'dispatched' : 'failed';
          t.request.error=t.request.status==='failed' ? (t.tasks.find(task=>task.error)?.error || t.request.error || '原执行已结束，可以重试；原失败记录保留在历史中') : undefined;
          t.request.recoveredAt=new Date().toISOString();this.requests.save(t.request);
        }
      } else {
        for (const task of t.tasks) this.checkTask(task,{locks:action!=='restore'});
        if (action==='retry') {
          if (t.tasks.length) {
            const retry=t.tasks.filter(task=>['failed','planned'].includes(task.status));
            if (!retry.length || t.tasks.some(task=>!['failed','planned','approved'].includes(task.status))) throw new Error('只重试失败或未启动任务；待审查/返工须先由 GPT 处理');
            // 所有仓库先检查，再派发；中途失败保留各任务实际状态，不重放成功项。
            for (const task of retry) this.workflow.checkRetry(task.id);
            for (const task of retry) {await this.workflow.prepareRetry(task.id);await this.workflow.start(task.id);}
            if (t.request) {t.request.status='dispatched';delete t.request.error;this.requests.save(t.request);}
          } else {
            if (t.request?.status!=='failed') throw new Error('仅失败规划可重试，请先异常恢复');
            await this.requests.retryPlanning(t.request.id);
          }
        } else {
          if (t.tasks.some(task=>!['failed','planned','approved','needs_changes'].includes(task.status))) throw new Error('任务未结束，不能归档');
          if (['planning','dispatching'].includes(t.request?.status)) throw new Error('规划状态未恢复，不能归档');
          const archivedAt=action==='archive' ? new Date().toISOString() : undefined;
          for (const task of t.tasks) this.workflow.operation(task.id,current=>{
            if (current.updatedAt!==task.updatedAt || current.status!==task.status) throw new Error('任务状态已变化');
            current.archivedAt=archivedAt;this.workflow.save(current);
          });
          if (t.request) {t.request.archivedAt=archivedAt;this.requests.save(t.request);}
        }
      }
      return {key:t.key,action,notice:({recover:'已核对执行状态；未重新派发',retry:'已开始重试，原记录保留',archive:'已归档，可在已归档列表恢复显示',restore:'已恢复显示；未重新派发'})[action]};
    } finally {this.busy.delete(t.key);}
  }
}
