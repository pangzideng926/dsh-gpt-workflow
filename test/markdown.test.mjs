import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/receiver-markdown.mjs';

test('任务文档渲染标题、表格和保留缩进的代码块', () => {
  const html = renderMarkdown('# 实施方案\n\n## 验收\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | **通过** |\n\n```js\nfunction run() {\n  return "<ok>";\n}\n```');
  assert.match(html, /<h1>实施方案<\/h1>/);
  assert.match(html, /<h2>验收<\/h2>/);
  assert.match(html, /<div class="gwr-table-scroll"><table>/);
  assert.match(html, /<th>项目<\/th>/);
  assert.match(html, /<td><strong>通过<\/strong><\/td>/);
  assert.match(html, /<pre><code class="language-js">function run\(\) \{\n  return &quot;&lt;ok&gt;&quot;;\n\}\n<\/code><\/pre>/);
});

test('审查文档渲染列表、引用、行内代码和普通链接', () => {
  const html = renderMarkdown('## GPT 审查\n\n1. 检查 `npm test`\n2. **通过**\n\n> 证据已核对\n\n[说明](https://example.com/docs)');
  for (const fragment of ['<ol>', '<code>npm test</code>', '<strong>通过</strong>', '<blockquote>', '<a href="https://example.com/docs">说明</a>']) assert.ok(html.includes(fragment), fragment);
});

test('任务中的 HTML、危险链接、代码属性与图片不能注入或执行', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[坏链接](javascript:alert(1))\n\n[数据](data:text/html;base64,PHNjcmlwdD4=)\n\n```\" onmouseover=\"alert(1)\n<script>evil()</script>\n```\n\n![说明](https://example.com/tracker.png)');
  assert.ok(!/<script|<img|href="(?:javascript|data):|class="[^"]*" onmouseover=/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(html.includes('<span class="gwr-image-alt">说明</span>'));
});
