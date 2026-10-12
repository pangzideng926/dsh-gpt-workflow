// 显式运行的真实 DSH 冒烟；会消耗用户现有 DSH 模型额度。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workflow } from '../src/workflow.mjs';

const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('请传入一个尚不存在的绝对路径作为演示目录');
fs.mkdirSync(destination); // 不覆盖既有目录。
const repo = path.join(destination, 'demo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
git('init', '-b', 'main');
git('config', 'user.name', 'Workflow Smoke');
git('config', 'user.email', 'smoke@example.invalid');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
fs.writeFileSync(path.join(repo, 'label.mjs'), 'export function normalizeLabel(value) { return value; }\n');
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 演示仓库\n仅修改 label.mjs 并新增 label.test.mjs。先写测试确认预期失败，再实现通过。禁止 Git 提交、推送、切分支；由 GPT 审查后统一收尾。不要运行子代理。\n');
git('add', 'package.json', 'label.mjs', 'AGENTS.md');
git('commit', '-m', '初始化独立冒烟示例');
const plan = `# 实施方案：标签文本规范化

## 目标与范围
修复 label.mjs 中 normalizeLabel。只修改该文件并新增 label.test.mjs，不引入依赖。

## 代码依据
label.mjs 当前直接返回 value；package.json 已配置 node --test；AGENTS.md 限定写入范围。

## 实施步骤
先用 node:test 写回归测试并运行，确认断言因当前实现失败；再实现并运行测试通过。

## 验收标准
1. 字符串去掉前后空白，中间连续空白折叠为一个普通空格。
2. 空字符串或纯空白返回空字符串。
3. 中文保持原文。
4. 非字符串参数抛出 TypeError。

## 测试要求
运行 node --test label.test.mjs，报告实现前失败及实现后通过的真实命令、退出码。不执行 Git 收尾。`;
const workflow = new Workflow({ timeoutMs: 300000 });
const task = await workflow.create({ repo, title: '真实 DSH 冒烟：标签规范化', plan });
fs.writeFileSync(path.join(destination, 'task-id.json'), JSON.stringify({ id: task.id }, null, 2));
console.log(JSON.stringify(process.argv.includes('--prepare') ? task : await workflow.start(task.id), null, 2));
