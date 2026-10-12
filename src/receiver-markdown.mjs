import MarkdownIt from 'markdown-it';

// 内容来自任务文档和模型输出：只允许解析器生成 HTML，不透传原始 HTML。
// 保留 markdown-it 默认的危险链接过滤；不启用返回任意 HTML 的高亮插件。
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
markdown.renderer.rules.table_open = () => '<div class="gwr-table-scroll"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
// 文档中的图片只显示说明，避免阅读任务时自动向外部地址发送请求。
markdown.renderer.rules.image = (tokens, index) =>
  `<span class="gwr-image-alt">${markdown.utils.escapeHtml(tokens[index].content)}</span>`;

export function renderMarkdown(source) {
  return markdown.render(source || '');
}
