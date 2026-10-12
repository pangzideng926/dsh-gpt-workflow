import fs from 'node:fs';
import { Workflow } from './workflow.mjs';

const [action, inputFile] = process.argv.slice(2);
if (!['create', 'start', 'status', 'list', 'result', 'review', 'revise', 'recover'].includes(action)) {
  console.error('用法：node src/cli.mjs <create|start|status|list|result|review|revise|recover> [参数.json 或 -]');
  process.exitCode = 1;
} else {
  try {
    const args = inputFile ? JSON.parse(fs.readFileSync(inputFile === '-' ? 0 : inputFile, 'utf8').replace(/^\uFEFF/, '')) : {};
    const workflow = new Workflow();
    const result = action === 'create' ? await workflow.create(args)
      : action === 'list' ? await workflow.list()
      : ['review', 'revise'].includes(action) ? await workflow[action](args.id, args)
      : await workflow[action](args.id);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
