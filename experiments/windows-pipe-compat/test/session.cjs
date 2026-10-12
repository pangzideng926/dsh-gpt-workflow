const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const probe=path.resolve(__dirname,'../.artifacts/security-probe.exe');
async function main() {
  if(process.argv[2]==='hold') {
    const pipe='\\\\?\\pipe\\dsh-compat-scope-'+process.env.DSH_PIPE_SCOPE_SID;
    const server=spawn(probe,['serve',pipe]);
    const ready=await once(server.stdout,'data');
    assert.equal(ready[0].toString().trim(),'ready');
    const canary=path.join(os.tmpdir(),'session-canary.txt');fs.writeFileSync(canary,'unchanged');
    console.log(JSON.stringify({pipe,temp:os.tmpdir(),scope:process.env.DSH_PIPE_SCOPE_SID,pid:process.pid}));
    await once(process.stdin,'data');
    const local=spawnSync(probe,['open',pipe,'write'],{encoding:'utf8'});
    assert.equal(local.status,0,local.stderr);assert.equal(JSON.parse(local.stdout).error,0);
    const closed=once(server,'close');server.stdin.end('\n');await closed;
    assert.equal(fs.readFileSync(canary,'utf8'),'unchanged');
    process.stdin.destroy();
  } else {
    const foreign=JSON.parse(process.env.TEST_FOREIGN_SESSION);
    assert.notEqual(process.env.DSH_PIPE_SCOPE_SID,foreign.scope);
    assert.notEqual(os.tmpdir(),foreign.temp);
    for(const fn of [()=>fs.writeFileSync(path.join(foreign.temp,'new.txt'),'forbidden'),()=>fs.writeFileSync(path.join(foreign.temp,'session-canary.txt'),'forbidden'),()=>fs.unlinkSync(path.join(foreign.temp,'session-canary.txt'))])
      assert.throws(fn,e=>['EPERM','EACCES'].includes(e.code));
    const r=spawnSync(probe,['open',foreign.pipe,'write'],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).error,5);
    console.log(JSON.stringify({foreignTempWriteDenied:true,foreignPipeWriteDenied:true,temp:os.tmpdir(),scope:process.env.DSH_PIPE_SCOPE_SID,pid:process.pid}));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
