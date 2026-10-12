const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const r=spawnSync(path.join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/DeepSeek Harness.exe'),[path.join(__dirname,'prepare.cjs')],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:''}});
fs.mkdirSync(path.join(__dirname,'../.artifacts'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'../.artifacts/prepare-result.json'),JSON.stringify({status:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2));
console.log(r.stdout);console.error(r.stderr.slice(-3000));process.exitCode=r.status??1;
