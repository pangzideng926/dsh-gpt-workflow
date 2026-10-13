import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// 独立 stdio 客户端只管理自己启动的进程，不接管桌面进程或修改会话数据库。
export class CodexRpc extends EventEmitter {
  constructor(bin, {signal, stderr = 'ignore', cwd, timeoutMs = 600000, closeTimeoutMs = 5000, onToolCall, onSpawn, spawnProcess = spawn} = {}) {
    super(); this.pending = new Map(); this.seq = 0; this.closeTimeoutMs=closeTimeoutMs;
    this.child = spawnProcess(bin, ['app-server', '--listen', 'stdio://'], {cwd, windowsHide:true, shell:false, stdio:['pipe','pipe',stderr]});
    this.lines = createInterface({input:this.child.stdout});
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        if (message.method === 'item/tool/call' && onToolCall) {
          Promise.resolve().then(()=>onToolCall(message.params)).then(result=>{
            if (!this.closed) this.child.stdin.write(JSON.stringify({id:message.id,result})+'\n');
          }).catch(error=>{
            if (!this.closed) this.child.stdin.write(JSON.stringify({id:message.id,error:{code:-32602,message:error.message}})+'\n');
            this.fail(error);
          });
          return;
        }
        // 不替用户批准权限，不让无人值守的规划停在隐藏确认框。
        this.child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'只读规划端不支持交互请求，请回 Codex 处理'}})+'\n');
        this.fail(new Error('规划需要交互，请打开 GPT 会话处理')); return;
      }
      if (message.id != null) {
        const p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
      } else this.emit('notification', message);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => { this.exited=true; if (!this.closed) this.fail(new Error(`Codex 会话服务退出（${code}）`)); });
    this.child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    this.abort = () => this.fail(new Error('GPT 规划被取消'));
    this.signal = signal; signal?.addEventListener('abort', this.abort, {once:true});
    this.deadline = setTimeout(() => this.fail(new Error('GPT 规划超过 10 分钟，已停止')), timeoutMs);
    try {onSpawn?.(this.child.pid);} catch(error) {this.fail(error);}
    if (signal?.aborted) this.abort();
  }
  fail(error) {
    if (this.closed) return;
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error); this.close();
  }
  request(method, params) {
    if (this.closed) return Promise.reject(this.failure || new Error('Codex 会话服务已关闭'));
    return new Promise((resolve, reject) => {
      const id=++this.seq;
      const timer=setTimeout(()=>this.fail(new Error(`Codex 接口超时：${method}`)),30000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closed=true; clearTimeout(this.deadline);
    this.signal?.removeEventListener('abort',this.abort);
    for (const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new Error('Codex 会话服务已关闭'));}
    this.pending.clear(); this.lines.close();
    // stdin.end 仅发出关闭请求；必须等自己的进程退出，才能把会话交回桌面。
    this.closing=new Promise((resolve,reject)=>{
      if (this.exited) {resolve();return;}
      const killTimer=setTimeout(()=>{
        try {this.child.kill();} catch { /* 超时后报告释放失败，不假装已释放。 */ }
      },Math.min(2000,this.closeTimeoutMs / 2));
      const deadline=setTimeout(()=>{clearTimeout(killTimer);reject(new Error('GPT 规划进程未退出，会话可能仍被占用；请先结束原规划进程再重试'));},this.closeTimeoutMs);
      this.child.once('close',()=>{clearTimeout(killTimer);clearTimeout(deadline);resolve();});
      this.child.stdin.end();
    });
    // fail/abort 路径可能无人等待；规划调用方仍须 await 并检查释放结果。
    this.closing.catch(()=>{});
    return this.closing;
  }
}

export async function connectCodex(bin, options) {
  const client=new CodexRpc(bin,options);
  try {
    await client.request('initialize',{clientInfo:{name:'dsh_gpt_workflow',title:'GPT × DSH 工作流',version:'0.2.0'},capabilities:{experimentalApi:true}});
    client.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    return client;
  } catch(error) {await client.close();throw error;}
}
