const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const probe=path.resolve(__dirname,'../.artifacts/security-probe.exe');
const workspace=process.cwd();
const writing=process.env.TEST_SANDBOX_MODE==='workspace-write';
function denied(fn) { assert.throws(fn,e=>['EPERM','EACCES'].includes(e.code)); }
test('后代令牌仍受限、Low，且无宽泛写身份',()=>{
  const r=spawnSync(probe,['token'],{encoding:'utf8'});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
  const token=JSON.parse(r.stdout);
  assert.equal(token.restricted,true);assert.equal(token.integrity,4096);
  assert.ok(token.sids.includes(process.env.DSH_PIPE_SCOPE_SID));
  for(const broad of ['S-1-5-11','S-1-5-4','S-1-2-0','S-1-2-1']) assert.ok(!token.sids.includes(broad));
  assert.equal(token.sids.length,writing?5:3);
});
test('工作区创建文件遵守模式，read-only 不因既有 grant 放行',()=>{
  const file=path.join(workspace,`write-${process.pid}.txt`);
  if(writing) { fs.writeFileSync(file,'ok');assert.equal(fs.readFileSync(file,'utf8'),'ok');fs.unlinkSync(file); }
  else denied(()=>fs.writeFileSync(file,'forbidden'));
});
test('私有临时目录按模式可写',()=>{
  const file=path.join(os.tmpdir(),`own-temp-${process.pid}.txt`);
  if(writing) {fs.writeFileSync(file,'ok');fs.unlinkSync(file);}
  else denied(()=>fs.writeFileSync(file,'forbidden'));
});
test('工作区外创建、覆写、删除仍拒绝',()=>{
  const outside=process.env.TEST_OUTSIDE;
  assert.ok(outside);
  denied(()=>fs.writeFileSync(path.join(outside,'new.txt'),'forbidden'));
  denied(()=>fs.writeFileSync(path.join(outside,'canary.txt'),'forbidden'));
  denied(()=>fs.unlinkSync(path.join(outside,'canary.txt')));
  assert.equal(fs.readFileSync(path.join(outside,'canary.txt'),'utf8'),'unchanged');
});
test('不加载兼容模块的后代仍保持原始管道拒绝，无静默提权',()=>{
  const r=spawnSync(process.execPath,['-e','const r=require("child_process").spawnSync(process.execPath,["-e","process.exit(0)"]);console.log(r.error?.code)'],{env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'EPERM');
});
test('伪造或缺少 IPC 身份时加载失败',()=>{
  const token=JSON.parse(spawnSync(probe,['token'],{encoding:'utf8'}).stdout);
  const nonIpcCapabilities=token.sids.filter(sid=>sid.startsWith('S-1-4-')&&sid!==process.env.DSH_PIPE_SCOPE_SID);
  for(const sid of ['', 'S-1-4-123-456-789-123-2', ...nonIpcCapabilities]) {
    const r=spawnSync(process.execPath,['-e','console.log("must-not-run")'],{env:{...process.env,DSH_PIPE_SCOPE_SID:sid},encoding:'utf8'});
    assert.ifError(r.error);assert.notEqual(r.status,0);assert.match(r.stderr,/DSH_PIPE_COMPAT_DENIED/);assert.doesNotMatch(r.stdout,/must-not-run/);
  }
});
