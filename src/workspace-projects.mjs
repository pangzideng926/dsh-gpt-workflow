import fs from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set(['tmp', 'temp', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'log', 'logs', 'midscene_run', '资料', '归档']);
const displayPath = value => value.replaceAll('\\', '/');

// 仅在打开项目选择或手动刷新时读取目录；不遍历仓库内容，不执行根目录 Git 命令。
export async function listWorkspaceProjects({ root = process.env.DSH_WORKFLOW_WORKSPACE_ROOT || 'E:/Eworkspace', maxDirectories = 400 } = {}) {
  let base;
  try { base = await fs.realpath(root); if (!(await fs.stat(base)).isDirectory()) throw new Error(); }
  catch { throw new Error(`主工作区不可读取：${root}`); }
  const projects = [], queue = [{ dir: base, depth: 0 }];
  let visited = 0, unreadable = 0;
  while (queue.length && visited < maxDirectories) {
    const { dir, depth } = queue.shift(); visited++;
    if (depth) {
      try {
        const marker = path.join(dir, '.git'), info = await fs.lstat(marker);
        let gitDir = info.isDirectory() ? marker : null;
        if (info.isFile()) {
          const match = /^gitdir: (.+)\s*$/m.exec(await fs.readFile(marker, 'utf8'));
          if (match) gitDir = path.resolve(dir, match[1].trim());
        }
        if (gitDir && (await fs.stat(path.join(gitDir, 'HEAD'))).isFile()) {
          projects.push({ name: path.basename(dir), relativePath: displayPath(path.relative(base, dir)), path: displayPath(dir) });
          continue;
        }
      } catch { /* 普通目录继续按有限层级查找；最终提交仍校验真实 Git 根目录。 */ }
    }
    if (depth >= 3) continue;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { unreadable++; continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || /^[._]/.test(entry.name) || excluded.has(entry.name.toLowerCase())) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { root: displayPath(base), projects: projects.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN')), truncated: queue.length > 0, unreadable };
}
