import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaceProjects } from '../src/workspace-projects.mjs';

test('项目选择包含分组下的仓库，排除工作区本身、临时目录和仓库内部', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-projects-'));
  const repo = async relative => {
    const dir = path.join(root, relative, '.git');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  };
  await repo(''); await repo('工具'); await repo('SJ/旧标准/API');
  await repo('.tmp/demo'); await repo('tmp/demo'); await repo('归档/old');
  await repo('工具/node_modules/dependency'); await repo('invalid/inside/deep/hidden');
  await fs.mkdir(path.join(root, 'not-a-repo/.git'), { recursive: true });
  const catalog = await listWorkspaceProjects({ root });
  const canonical = await fs.realpath(root);
  assert.deepEqual(catalog.projects.map(p => p.relativePath).sort(), ['SJ/旧标准/API', '工具']);
  assert.equal(catalog.projects.find(p => p.name === 'API').path, path.join(canonical, 'SJ/旧标准/API').replaceAll('\\', '/'));
  assert.equal(catalog.root, canonical.replaceAll('\\', '/'));
});

test('目录联接不离开主工作区，Git worktree 文件可识别', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-projects-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-projects-outside-'));
  await fs.mkdir(path.join(outside, '.git'));
  await fs.writeFile(path.join(outside, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.symlink(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'worktree'));
  await fs.writeFile(path.join(root, 'worktree/.git'), `gitdir: ${path.join(outside, '.git')}\n`, 'utf8');
  const catalog = await listWorkspaceProjects({ root });
  assert.deepEqual(catalog.projects.map(p => p.name), ['worktree']);
});

test('目录读取有上限，主工作区不存在时报告错误', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-projects-limit-'));
  await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'));
  const catalog = await listWorkspaceProjects({ root, maxDirectories: 1 });
  assert.equal(catalog.truncated, true);
  await assert.rejects(listWorkspaceProjects({ root: path.join(root, 'missing') }), /主工作区/);
});
