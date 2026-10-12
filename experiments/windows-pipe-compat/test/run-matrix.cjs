'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const install=path.join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness');
const exe=path.join(install,'DeepSeek Harness.exe');
const runner=path.join(root,'.artifacts/runtime/runner.js');
const resultFile=path.join(root,'.artifacts/matrix.json');
const results={started:new Date().toISOString(),checks:[]};
const nodes=[process.execPath,path.join(os.homedir(),'.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe')];
const base=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-pipe-matrix-'));
const workspace=path.join(base,'workspace');const outside=path.join(base,'outside');
fs.mkdirSync(workspace);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'canary.txt'),'unchanged');
results.base=base;
function args(node,mode,extra){return [runner,'--workspace',workspace,'--temp',os.tmpdir(),'--mode',mode,'--',node,...extra];}
function options(mode,extra={}){return {cwd:workspace,windowsHide:true,encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'',TEST_SANDBOX_MODE:mode,TEST_OUTSIDE:outside,...extra}};}
function check(name,r){const row={name,status:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr};results.checks.push(row);fs.writeFileSync(resultFile,JSON.stringify(results,null,2));assert.ifError(r.error);assert.equal(r.status,0,`${name}\n${r.stdout}\n${r.stderr}`);console.log('PASS '+name);}
async function main(){
  for(const node of nodes) {
    assert.ok(fs.existsSync(node));
    const version=spawnSync(node,['--version'],{encoding:'utf8'}).stdout.trim();
    for(const mode of ['workspace-write','read-only']) {
      check(`${version} ${mode} 默认 node --test`,spawnSync(exe,args(node,mode,['--test',path.join(__dirname,'stdio.test.cjs'),path.join(__dirname,'boundaries.test.cjs')]),{...options(mode),timeout:45000}));
    }
    const failure=spawnSync(exe,args(node,'workspace-write',['--test',path.join(__dirname,'intentional-failure.cjs')]),{...options('workspace-write'),timeout:15000});
    assert.ifError(failure.error);assert.equal(failure.status,1);assert.match(failure.stdout,/expected-assertion-failure/);assert.match(failure.stdout,/(?:#|ℹ) fail 1/);assert.doesNotMatch(failure.stdout+failure.stderr,/spawn EPERM/);
    results.checks.push({name:`${version} 真实断言失败仍返回 1`,expectedStatus:1,status:failure.status,stdout:failure.stdout,stderr:failure.stderr});
    console.log('PASS '+version+' 真实失败退出码');
  }
  // Two overlapping restricted runners, each with its own IPC and temp SID.
  const a=spawn(exe,args(nodes[0],'workspace-write',[path.join(__dirname,'session.cjs'),'hold']),options('workspace-write'));
  let aErr='',aOut='';a.stderr.on('data',b=>aErr+=b);a.stdout.on('data',b=>aOut+=b);
  const aClosed=once(a,'close');
  const timeout=setTimeout(()=>a.kill(),30000);
  try {
    let pending='';
    const ready=await new Promise((resolve,reject)=>{
      a.on('error',reject);a.once('exit',code=>reject(new Error('Session A exited before readiness: '+code+' '+aErr)));
      a.stdout.on('data',data=>{pending+=data;if(pending.includes('\n'))try{resolve(JSON.parse(pending.split('\n')[0]));}catch(e){reject(e);}});
    });
    results.sessionA=ready;
    const b=spawnSync(exe,args(nodes[0],'workspace-write',[path.join(__dirname,'session.cjs'),'check']),{...options('workspace-write',{TEST_FOREIGN_SESSION:JSON.stringify(ready)}),timeout:20000});
    check('跨会话临时目录及管道拒绝写入',b);
    results.sessionB=JSON.parse(b.stdout.trim());
    assert.equal(fs.existsSync(results.sessionB.temp),false,'Session B private temp must be revoked and removed');
    a.stdin.end('release\n');
    const [code]=await aClosed;
    check('同会话管道可写，退出释放并清理私有目录',{status:code,stdout:aOut,stderr:aErr});
    assert.equal(fs.existsSync(ready.temp),false);
    results.privateTempsCleaned=true;
  } finally {clearTimeout(timeout);if(a.exitCode===null)a.kill();}
  const plain=spawnSync(nodes[0],['--require',path.join(root,'preload.cjs'),'-e','console.log("must-not-run")'],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',DSH_PIPE_SCOPE_SID:'S-1-4-123-456-789-123-2'},windowsHide:true});
  assert.notEqual(plain.status,0);assert.match(plain.stderr,/DSH_PIPE_COMPAT_DENIED/);assert.doesNotMatch(plain.stdout,/must-not-run/);
  results.unrestrictedLoadRejected=true;
  const previous=JSON.parse(fs.readFileSync(path.join(root,'.artifacts/source.json'),'utf8'));
  const hash=createHash('sha256').update(fs.readFileSync(path.join(install,'resources/app.asar'))).digest('hex');
  assert.equal(hash,previous.asarHash);results.productionAsarUnchanged=true;
  assert.equal(fs.readFileSync(path.join(outside,'canary.txt'),'utf8'),'unchanged');
  results.finished=new Date().toISOString();results.ok=true;
  console.log('PASS 拒绝不受限进程加载，正式安装哈希不变');
}
main().catch(e=>{results.failure=e.stack;console.error(e);process.exitCode=1;}).finally(()=>fs.writeFileSync(resultFile,JSON.stringify(results,null,2)));
