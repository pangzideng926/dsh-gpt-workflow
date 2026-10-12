import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.argv[2];
console.log(JSON.stringify({ type: 'session', sessionId: 'session-offline-test' }));
if (mode === 'slow') await new Promise(r => setTimeout(r, 900));
if (mode === 'timeout') await new Promise(r => setTimeout(r, 60000));
if (!prompt.includes('实施方案')) process.exit(3);
if (mode !== 'fail' && mode !== 'missing-final') writeFileSync('result.txt', 'DSH 离线替身实现\n');
if (mode === 'commit') {
  execFileSync('git', ['add', 'result.txt'], { windowsHide: true });
  execFileSync('git', ['commit', '-m', '模拟违规提交'], { windowsHide: true });
}
if (mode === 'error-event') console.log(JSON.stringify({ type: 'error', message: '模拟运行错误' }));
if (mode !== 'missing-final') console.log(JSON.stringify({ type: 'final', text: '实现完成；此处是离线替身，不是真实 DSH。' }));
process.exit(mode === 'fail' ? 1 : 0);
