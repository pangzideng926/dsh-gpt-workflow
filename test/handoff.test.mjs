import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSections, reportCoverage, nextStep, renderHandoff } from '../src/handoff.mjs';
import { renderMarkdown } from '../src/receiver-markdown.mjs';

test('交接章节忽略代码围栏里的假标题，报告缺项不伪造结果', () => {
  const text = '## 已改文件\nREADME.md\n```md\n## 测试记录\n全通过\n```\n## 验收结果\nA1 待核对';
  assert.equal(readSections(text)['测试记录'], undefined);
  assert.deepEqual(reportCoverage(text).missing, ['测试记录', '未完成与阻塞', '交回 GPT']);
  assert.ok(reportCoverage('## 测试记录\n\n## 交回 GPT\n核对').missing.includes('测试记录'));
});

test('状态决定交接下一步，中断不建议重放或解除锁，旧任务可降级查看', () => {
  assert.equal(nextStep('running').owner, 'DSH');
  assert.equal(nextStep('interrupted').action, 'inspect');
  assert.equal(nextStep('needs_changes').action, 'revise');
  const text = renderHandoff({ title:'旧任务', repo:'fixture', status:'interrupted', error:'宿主中断' });
  assert.match(text, /历史任务/);
  assert.match(text, /不重放/);
  assert.match(text, /宿主中断/);
});

test('摘要保留真实测试和阻塞说明，Markdown 渲染不会执行模型输出', () => {
  const answer = '## 已改文件\nREADME.md\n## 验收结果\nA1 未验证\n## 测试记录\n| 命令 | 结果 |\n| --- | --- |\n| npm test | 未运行 |\n## 未完成与阻塞\n缺少环境\n## 交回 GPT\n<script>alert(1)</script>';
  assert.deepEqual(reportCoverage(answer).missing, []);
  assert.match(reportCoverage(answer).sections['测试记录'], /未运行/);
  const markdown = renderHandoff({ title:'待核查', repo:'fixture', status:'completed', plan:'## 验收标准\nA1 文件存在', answer });
  assert.match(markdown, /接手：GPT/);
  assert.match(markdown, /A1 文件存在/);
  assert.match(markdown, /缺少环境/);
  const html = renderMarkdown(markdown);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>/);
});
