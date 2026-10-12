import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP 握手、九个工具发现、无害查询和参数校验', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-gpt-mcp-'));
  const server = process.env.DSH_WORKFLOW_TEST_SERVER || fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, DSH_WORKFLOW_HOME: home } });
  const client = new Client({ name: 'workflow-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.equal(tools.find(t => t.name === 'workflow_handoff').annotations.readOnlyHint, true);
    assert.ok(tools.some(t => t.name === 'workflow_review'));
    const result = await client.callTool({ name: 'workflow_list', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), []);
    const invalid = await client.callTool({ name: 'workflow_status', arguments: { id: '../outside' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
test('通过 MCP 启动独立 worker，开发结果回传并提交 GPT 审查结论', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-gpt-mcp-run-'));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'MCP Test'); git('config', 'user.email', 'mcp@example.invalid');
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', 'README.md'); git('commit', '-m', '初始化');
  const server = process.env.DSH_WORKFLOW_TEST_SERVER || fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: {
    ...process.env, DSH_WORKFLOW_HOME: path.join(root, 'state'),
    DSH_WORKFLOW_BIN: fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url)),
  } });
  const client = new Client({ name: 'workflow-e2e-test', version: '1.0.0' });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const plan = '# 实施方案\n\n## 目标与范围\n演示。\n## 代码依据\nREADME.md\n## 实施步骤\n新增 result.txt。\n## 验收标准\n文件存在。\n## 测试要求\n核对内容。';
    const task = await call('workflow_create', { repo, title: 'MCP 完整闭环', plan });
    assert.equal((await call('workflow_handoff', { id: task.id })).next.action, 'start');
    await call('workflow_start', { id: task.id });
    let status;
    for (let n = 0; n < 120; n++) {
      status = await call('workflow_status', { id: task.id });
      if (status.status !== 'running') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'awaiting_review');
    const result = await call('workflow_result', { id: task.id });
    assert.match(readFileSync(path.join(repo, 'result.txt'), 'utf8'), /离线替身/);
    const reviewed = await call('workflow_review', { id: task.id, verdict: 'approved', summary: '测试客户端已核对实际文件；这是离线协议验证，不代表真实 GPT 审查。', evidenceHash: result.evidenceHash });
    assert.equal(reviewed.status, 'approved');
  } finally { await client.close(); }
});
