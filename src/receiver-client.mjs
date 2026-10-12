import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const receiverHome = () => path.join(os.homedir(), '.dsh', 'gpt-workflow-receiver');
export async function receiverRequest(route, body, discoveryFile = process.env.DSH_WORKFLOW_RECEIVER_FILE || path.join(receiverHome(), 'connection.json')) {
  let config;
  try { config = JSON.parse(fs.readFileSync(discoveryFile, 'utf8')); }
  catch { throw new Error('DSH 接收插件未启动，请安装插件并打开 DSH 桌面应用'); }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url) || typeof config.token !== 'string') throw new Error('接收插件连接配置无效');
  const response = await fetch(config.url + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `接收插件 HTTP ${response.status}`);
  return result;
}
