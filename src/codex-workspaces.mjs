import fs from 'node:fs/promises';
import path from 'node:path';
import { connectCodex } from './codex-rpc.mjs';
import { resolveCodex } from './codex-planner.mjs';

// 使用 App Server 的项目接口，不读私有数据库，不创建模型会话。
export async function listCodexWorkspaces({connect=connectCodex,resolveBin=resolveCodex}={}) {
  const client=await connect(resolveBin(),{timeoutMs:15000});
  try {
    const workspaces=[], seen=new Set(); let cursor;
    for(let page=0;page<5;page++) {
      const response=await client.request('project/list',{limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(response.data)) throw new Error('Codex 项目接口响应无效');
      for(const project of response.data) for(const root of project.roots || []) {
        if(typeof root.path!=='string' || !path.isAbsolute(root.path)) continue;
        try {
          const real=await fs.realpath(root.path);
          if(!(await fs.stat(real)).isDirectory() || seen.has(real)) continue;
          seen.add(real); workspaces.push({id:project.id,name:project.name,path:real.replaceAll('\\','/')});
        } catch { /* 非本机或已失效目录不作为可执行的工作区。 */ }
      }
      cursor=response.nextCursor; if(!cursor)break;
    }
    return {workspaces,truncated:!!cursor};
  } finally {client.close();}
}
