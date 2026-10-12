// DSH 0.2.0-rc.2 客户端公开快照；不按“最近活跃”猜测目标。
export function currentDshWorkspace(sessions, workspaces) {
  const rows = Object.values(sessions?.byId || {});
  const current = rows.find(row => (row?.retainedBy?.mainView || 0) > 0);
  return current && workspaces?.items?.find(item => item.sessionIds?.includes(current.id));
}

export const requestTaskIds = request => request.taskIds || (request.taskId ? [request.taskId] : []);
export const ownsJob = (request, key) => typeof key==='string' && requestTaskIds(request).some(id => key.startsWith(`${id}-`) && /^\d+$/.test(key.slice(id.length+1)));
