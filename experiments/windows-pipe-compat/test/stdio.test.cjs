'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn, spawnSync, fork} = require('node:child_process');
const {once} = require('node:events');
const {Worker} = require('node:worker_threads');

test('默认测试文件确实位于子进程', t => {
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
  assert.notEqual(process.pid, process.ppid);
  t.diagnostic(JSON.stringify({pid:process.pid,ppid:process.ppid,context:process.env.NODE_TEST_CONTEXT}));
});
test('同步捕获 stdout、stderr、非零退出码及独立 PID', () => {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid);console.error("stderr-ok");process.exit(17)'], {encoding:'utf8'});
  assert.ifError(r.error);
  assert.equal(r.status, 17);
  assert.notEqual(Number(r.stdout.trim()), process.pid);
  assert.equal(r.stderr.trim(), 'stderr-ok');
});
test('异步管道支持双向大数据与关闭', async () => {
  const data = Buffer.alloc(1024 * 1024, 'x');
  const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']);
  const output = [];
  child.stdout.on('data', b => output.push(b));
  const closed = once(child, 'close');
  child.stdin.end(data);
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(Buffer.concat(output), data);
});
test('孙进程继承兼容加载与受限令牌', () => {
  const code = 'const r=require("child_process").spawnSync(process.execPath,["-e","console.log(42)"],{encoding:"utf8"});if(r.error)throw r.error;process.stdout.write(r.stdout);process.exit(r.status)';
  const r = spawnSync(process.execPath, ['-e', code], {encoding:'utf8'});
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '42');
});
test('worker 加载原生兼容模块后仍能启动管道子进程', async () => {
  const worker = new Worker('const {parentPort}=require("worker_threads");const r=require("child_process").spawnSync(process.execPath,["-e","process.exit(0)"],{encoding:"utf8"});parentPort.postMessage({status:r.status,error:r.error?.message});', {eval:true});
  const message = once(worker, 'message');
  const exited = once(worker, 'exit');
  assert.deepEqual((await message)[0], {status:0,error:undefined});
  assert.equal((await exited)[0], 0);
});
test('管道子进程可被终止并释放', async () => {
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)']);
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  assert.equal(child.kill(), true);
  await closed;
});
test('Node fork IPC 可传递消息', async () => {
  const child = fork(require.resolve('./ipc-child.cjs'), [], {silent:true});
  const closed = once(child, 'close');
  const reply = once(child, 'message');
  child.send({value:123});
  assert.deepEqual((await reply)[0], {value:123,pid:child.pid});
  assert.deepEqual(await closed, [0,null]);
});
