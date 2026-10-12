import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(root, '.runtime', 'plugin');
fs.mkdirSync(target, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/server.mjs', 'src/worker.mjs', 'src/cli.mjs'],
  outdir: path.join(target, 'dist'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: 'eof',
});
for (const name of ['plugin.json', 'mcp.json', '.codex-plugin', 'skills', 'README.md', 'docs']) {
  fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
}
console.log(`已构建独立插件：${target}`);
await build({ absWorkingDir: root, entryPoints: ['src/receiver-plugin.mjs'], outfile: path.join(root, 'dsh-receiver/lib/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
await build({ absWorkingDir: root, entryPoints: ['src/worker.mjs'], outfile: path.join(root, 'dsh-receiver/lib/worker.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
console.log('已构建 DSH 原生接收插件：dsh-receiver');
await build({ absWorkingDir: root, entryPoints: ['src/receiver-panel.js'], outfile: path.join(root, 'dsh-receiver/lib/client.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'eof' });
