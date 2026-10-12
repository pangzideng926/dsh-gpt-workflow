const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-pipe-compatible-'));
const runner=path.resolve(__dirname,'../.artifacts/runtime/runner.js');
const r=spawnSync(path.join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/DeepSeek Harness.exe'),[runner,'--workspace',workspace,'--temp',os.tmpdir(),'--mode','workspace-write','--',process.execPath,'--test',path.join(__dirname,'stdio.test.cjs')],{cwd:workspace,encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:''}});
fs.writeFileSync(path.join(__dirname,'../.artifacts/smoke.json'),JSON.stringify({workspace,status:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2));
console.log(r.stdout);console.error(r.stderr.slice(-2500));process.exitCode=r.status??1;
