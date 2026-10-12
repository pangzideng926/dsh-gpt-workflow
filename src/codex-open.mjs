import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export function codexThreadUrl(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('GPT 会话 ID 无效');
  return `codex://threads/${id}`;
}
export async function openCodexThread(id) {
  const url = codexThreadUrl(id);
  if (process.platform === 'win32') {
    // URI 只含校验后的 UUID，不拼接需求、路径或任意外部地址。
    await run('pwsh.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference = 'Stop'; Start-Process -FilePath '${url}'`],{windowsHide:true,timeout:15000});
  } else await run(process.platform === 'darwin' ? 'open' : 'xdg-open',[url],{timeout:15000});
}
