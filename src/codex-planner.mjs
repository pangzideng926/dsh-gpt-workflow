import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectCodex } from './codex-rpc.mjs';
import { planningTool, validatePlanningResult } from './planning-result.mjs';

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
  return async (request, update, inspectResult) => {
    const dir = request.generation>1 ? path.join(home,request.id,'attempts',String(request.generation)) : path.join(home,request.id); fs.mkdirSync(dir, { recursive: true });
    const stage = request.workspace ? request.stage : 'legacy', locating = stage === 'locate';
    const output = path.join(dir, `${stage}-result.json`);
    fs.writeFileSync(path.join(dir, `${stage}-schema.json`), JSON.stringify(planningTool.inputSchema));
    const scope = locating
      ? `工作区：${request.workspace}\n先自动定位此需求实际涉及的 Git 仓库。按需读取工作区规则、导航和相关目录/代码，不全量扫描，不要求用户手动选子仓库。工作区可能是多仓库目录；只有确定真实 Git 根目录后才能在那里运行只读 Git 命令，禁止在仅有 .git/hooks 的 E:/Eworkspace 根目录运行 Git。返回工作区内确实相关的 1～8 个仓库绝对路径 repos，并在 reason 说明代码依据；不要编写实施方案或猜测同名项目。工作区外项目或范围无法确定时返回 needs_input 与具体问题。`
      : request.workspace
        ? `工作区：${request.workspace}\n已确认执行仓库：${JSON.stringify(request.repos)}\n这些仓库的基线已冻结，请只读核对代码并返回 tasks 数组，每个仓库一份 {repo,title,plan}；必须覆盖且仅覆盖上述仓库，不得扩大范围。跨仓库依赖在各方案中说明；DSH 会分别开发并分别交回 GPT 审查。`
        : `目标仓库：${request.repo}`;
    const prompt = `你负责 GPT → DSH 工作流的只读规划阶段。\n${scope}\n先读取适用的 AGENTS.md 及相关代码和规范，基于实际存在的文件规划。不要开发、修改文件、运行有写入副作用的命令、修改权限、Git 收尾、派发子代理或调用 workflow_* 工具；外围程序会保存方案和启动 DSH。\n输出结构化结果。信息足够时 status=ready，title 为简短中文标题。${locating ? '本轮只定位仓库，后续将在同一会话中生成实施方案。' : '每份 plan 为中文 Markdown，必须含五个二级标题：目标与范围、代码依据、实施步骤、验收标准、测试要求；引用实际文件，列出3～5条可验证验收和必要测试，关键逻辑先失败后通过。'}信息不足则 status=needs_input，questions 写需要用户补充的问题，不猜测关键需求。\n用户需求：\n${request.requirement}`;
    const err = fs.openSync(path.join(dir, 'stderr.log'), 'a');
    let client, threadId, turnId, result, resultFeedback;
    let started;
    const turnStarted = new Promise(resolve=>{started=resolve;});
    try {
      const cwd=request.workspace || request.repo;
      update({gptSessionState:'starting',gptPid:undefined});
      client = await connect(resolveCodex(), {cwd, signal, stderr:err, onSpawn:pid=>update({gptPid:pid}), onToolCall:async params=>{
        await turnStarted;
        if (!turnId || params.threadId !== threadId || params.turnId !== turnId || params.tool !== planningTool.name || params.namespace) throw new Error('拒绝非当前规划回合的工具请求');
        let parsed;
        try { parsed=validatePlanningResult(params.arguments,stage); }
        catch(error) { return {success:false,contentItems:[{type:'inputText',text:`结果未接收，请修正后再提交：${error.message}`}]}; }
        if (result && JSON.stringify(result)!==JSON.stringify(parsed)) throw new Error('同一回合提交了冲突的规划结果，已停止派发');
        if (result) return {success:true,contentItems:[{type:'inputText',text:resultFeedback}]};
        let preflight='';
        if (!result && parsed.status==='ready' && inspectResult) {
          try { inspectResult(parsed); }
          catch(error) { preflight=`\n外围预检查未通过，本次已暂停、不会派发 DSH：${error.message}。请在最终回复显著说明原因；不要修改仓库、申请权限或改写已提交结果来绕过检查。`; }
        }
        result=parsed;
        const feedback=result.status==='needs_input'
          ? '已接收待补充问题；不会派发 DSH。请在最终 Markdown 回复中逐项列出问题。'
          : locating ? '仓库定位结果已接收。尚未生成方案或派发 DSH；接下来外围程序将检查仓库是否干净、是否被占用，通过后才进入实施方案阶段。请在最终 Markdown 中说明这一步，暂停原因可在 DSH 面板任务详情查看。'
          : '实施方案已接收。请在最终 Markdown 中展示方案，并说明仍待外围程序校验代码基线后派发；当前不能声称 DSH 已开始。';
        resultFeedback=preflight || feedback;
        return {success:true,contentItems:[{type:'inputText',text:resultFeedback}]};
      }});
      const {thread} = request.gptThreadId
        ? await client.request('thread/resume',{threadId:request.gptThreadId,cwd,sandbox:'read-only',approvalPolicy:'never',excludeTurns:true})
        : await client.request('thread/start', {cwd,sandbox:'read-only',approvalPolicy:'never',ephemeral:false,threadSource:'user',dynamicTools:[planningTool]});
      threadId=thread.id;
      update({gptThreadId:thread.id,gptSessionState:'owned',gptProgress:locating ? '正在定位相关仓库…' : '正在生成实施方案…'});
      await client.request('thread/name/set', {threadId:thread.id,name:`GPT 协作 · ${(request.title || request.requirement.split('\n')[0]).slice(0,40)}`});
      let answer = '';
      const done = new Promise((resolve,reject) => {
        client.once('failure',reject);
        client.on('notification', async event => {
          try {
            await turnStarted;
            if (!turnId || event.params?.threadId !== thread.id || (event.params.turnId || event.params.turn?.id) !== turnId) return;
            if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage' && event.params.item.phase === 'commentary') update({gptProgress:event.params.item.text.slice(0,4000)});
            if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage' && (!event.params.item.phase || event.params.item.phase === 'final_answer')) {
              answer = event.params.item.text;
              fs.appendFileSync(path.join(dir,'events.jsonl'), JSON.stringify(event)+'\n');
            }
            if (event.method === 'turn/completed') {
              const turn = event.params.turn;
              turn.status === 'completed' ? resolve() : reject(new Error(turn.error?.message || `GPT 规划未完成：${turn.status}`));
            }
          } catch(error) { reject(error); }
        });
      });
      // 提前挂接拒绝处理，避免 turn/start 失败与退出事件竞争产生未处理拒绝。
      done.catch(()=>{});
      const handoffGuidance = locating ? '' : '\n交接要求：代码依据列出精简的实际文件/规范引用及读取用途，注明开发/审查适用，不复制大段上下文；验收标准用稳定编号 A1、A2…，每条给出观察方法和期望结果；实施步骤注明依赖与停止交回 GPT 的条件；测试要求写工作目录、具体命令、环境前提，区分已验证事实和待验证假设。只维护这一份方案，不要求 Trellis 初始化、任务目录或额外三份文档。';
      const presentation = `\n本轮 stage=${stage}。先调用 submit_planning_result 提交结构化结果，不使用的字符串填空、数组填 []。不要把 JSON 放入最终回复；最终回复必须使用中文 Markdown，显示标题、仓库/代码依据、实施方案或需要补充的问题。明确当前阶段和下一步，不得声称已启动 DSH 或完成审查；派发前须由外围程序检查仓库基线和锁，暂停原因以 DSH 面板任务详情为准。`;
      const {turn}=await client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:prompt + handoffGuidance + presentation}]});
      turnId=turn.id; started();
      await done;
      if (!answer || Buffer.byteLength(answer)>300000) throw new Error('GPT 规划结果为空或过大');
      fs.writeFileSync(path.join(dir, `${stage}-answer.md`),answer);
      if (!result) throw new Error('GPT 未提交结构化规划结果，未派发 DSH；请查看 GPT 会话');
      fs.writeFileSync(output,JSON.stringify(result,null,2));
      await client.request('thread/name/set',{threadId:thread.id,name:`GPT 协作 · ${result.title || request.title || '待补充需求'}`});
      return result;
    } finally {
      started();
      try {
        await client?.close();
        if (threadId) update({gptSessionState:'released'});
      } catch(error) {
        if (threadId) update({gptSessionState:'release_failed'});
        throw error;
      } finally { fs.closeSync(err); }
    }
  };
}
