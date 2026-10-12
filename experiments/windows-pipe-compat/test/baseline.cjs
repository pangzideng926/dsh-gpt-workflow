'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const install = path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const runner = path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pipe-baseline-'));
const result = spawnSync(path.join(install, 'DeepSeek Harness.exe'), [runner,'--workspace',workspace,'--temp',os.tmpdir(),'--mode','workspace-write','--',process.execPath,'--test',path.join(__dirname,'stdio.test.cjs')], {
  cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:''},encoding:'utf8',windowsHide:true,timeout:30000
});
fs.mkdirSync(path.join(__dirname,'../.artifacts'), {recursive:true});
fs.writeFileSync(path.join(__dirname,'../.artifacts/baseline.json'), JSON.stringify({workspace,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message},null,2));
console.log(JSON.stringify({status:result.status,expectedFailure:result.status===1 && /spawn EPERM/.test(result.stdout + result.stderr)}));
if(result.status!==1 || !/spawn EPERM/.test(result.stdout+result.stderr)) process.exitCode=1;
