import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectCodex } from './codex-rpc.mjs';

export function resolveCodex() {
  if (process.env.DSH_WORKFLOW_CODEX_BIN) {
    const bin = fs.realpathSync(process.env.DSH_WORKFLOW_CODEX_BIN);
    if (/\.(cmd|bat|ps1)$/i.test(bin)) throw new Error('DSH_WORKFLOW_CODEX_BIN 必须指向 codex.exe，不能是 shell 包装器');
    return bin;
  }
  if (process.platform !== 'win32') return 'codex';
  // 桌面版可能比 PATH 上的旧 npm CLI 更新；优先使用已安装的桌面执行器。
  const desktop = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (process.env.LOCALAPPDATA && fs.existsSync(desktop)) {
    const candidates = fs.readdirSync(desktop).map(dir => path.join(desktop, dir, 'codex.exe')).filter(file => fs.existsSync(file)).map(file => {
      try { const version = execFileSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).match(/(\d+)\.(\d+)\.(\d+)(.*)/); return { file, version: version ? version[0].split(/\D+/).map(Number) : [] }; }
      catch { return { file, version: [] }; }
    }).filter(c => c.version.length).sort((a, b) => { for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) { const delta = (b.version[i] || 0) - (a.version[i] || 0); if (delta) return delta; } return 0; });
    if (candidates[0]) return candidates[0].file;
  }
  const roots = (process.env.PATH || '').split(path.delimiter);
  try { roots.unshift(path.dirname(execFileSync('volta', ['which', 'codex'], { encoding: 'utf8', windowsHide: true }).trim())); } catch { /* 尝试标准 npm 安装目录。 */ }
  for (const dir of roots) {
    const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
    for (const base of [pkg, path.join(pkg, 'node_modules', '@openai', `codex-win32-${process.arch}`), path.join(dir, 'node_modules', '@openai', `codex-win32-${process.arch}`)]) {
      const exe = path.join(base, 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`, 'bin', 'codex.exe');
      if (fs.existsSync(exe)) return exe;
    }
    const exe = path.join(dir, 'codex.exe'); if (fs.existsSync(exe)) return exe;
  }
  throw new Error('未找到本机 Codex CLI，请先安装并登录，或配置 DSH_WORKFLOW_CODEX_BIN');
}

export function createPlanner(home, signal, {connect = connectCodex} = {}) {
  return async (request, update) => {
    const dir = path.join(home, request.id); fs.mkdirSync(dir, { recursive: true });
    const schema = path.join(dir, 'schema.json'), output = path.join(dir, 'result.json');
    fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { status: { type: 'string', enum: ['ready', 'needs_input'] }, title: { type: 'string' }, plan: { type: 'string' }, questions: { type: 'string' } }, required: ['status', 'title', 'plan', 'questions'], additionalProperties: false }));
    const prompt = `你负责 GPT → DSH 工作流的只读规划阶段。用户要求生成实施方案并交 DSH 开发。\n目标仓库：${request.repo}\n先读取适用的 AGENTS.md 及相关代码和规范，基于实际存在的文件规划。不要开发、修改文件、运行有写入副作用的命令、Git 收尾、派发子代理或调用 workflow_* 工具；外围程序会保存方案和启动 DSH。\n输出结构化结果。信息足够时 status=ready，title 为简短中文标题，plan 为中文 Markdown，必须含五个二级标题：目标与范围、代码依据、实施步骤、验收标准、测试要求；引用实际文件，列出3～5条可验证验收和必要测试，关键逻辑先失败后通过。信息不足则 status=needs_input，questions 写需要用户补充的问题，不猜测关键需求。\n用户需求：\n${request.requirement}`;
    const err = fs.openSync(path.join(dir, 'stderr.log'), 'a');
    let client;
    try {
      client = await connect(resolveCodex(), {cwd:request.repo, signal, stderr:err});
      const {thread} = await client.request('thread/start', {cwd:request.repo, sandbox:'read-only', approvalPolicy:'never', ephemeral:false, threadSource:'user'});
      update({gptThreadId:thread.id});
      await client.request('thread/name/set', {threadId:thread.id,name:`GPT 协作 · ${(request.title || request.requirement.split('\n')[0]).slice(0,40)}`});
      let answer = '';
      const done = new Promise((resolve,reject) => {
        client.once('failure',reject);
        client.on('notification', event => {
          if (event.params?.threadId !== thread.id) return;
          if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') {
            answer = event.params.item.text;
            fs.appendFileSync(path.join(dir,'events.jsonl'), JSON.stringify(event)+'\n');
          }
          if (event.method === 'turn/completed') {
            const turn = event.params.turn;
            turn.status === 'completed' ? resolve() : reject(new Error(turn.error?.message || `GPT 规划未完成：${turn.status}`));
          }
        });
      });
      // 提前挂接拒绝处理，避免 turn/start 失败与退出事件竞争产生未处理拒绝。
      done.catch(()=>{});
      await client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:prompt}],outputSchema:JSON.parse(fs.readFileSync(schema,'utf8'))});
      await done;
      if (!answer || Buffer.byteLength(answer)>300000) throw new Error('GPT 规划结果为空或过大');
      const result = JSON.parse(answer);
      fs.writeFileSync(output,JSON.stringify(result,null,2));
      await client.request('thread/name/set',{threadId:thread.id,name:`GPT 协作 · ${result.title || request.title || '待补充需求'}`});
      return result;
    } finally { client?.close(); fs.closeSync(err); }
  };
}
