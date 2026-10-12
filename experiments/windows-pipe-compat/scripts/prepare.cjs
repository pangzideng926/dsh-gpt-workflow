'use strict';
// Run with the installed Electron CLI: it can read app.asar without extracting
// or changing production files. Only exact known patch points are accepted.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const install = path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/app.asar');
const original = path.join(install,'dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib');
const out = path.join(root,'.artifacts/runtime');
fs.mkdirSync(out,{recursive:true});
function replaceOne(text, old, next) {
  if (text.split(old).length !== 2) throw new Error('Installed source patch point changed: '+old.slice(0,100));
  return text.replace(old,next);
}
function imports(text, source) {
  const resolve = createRequire(source);
  return text.replace(/from "([^".][^"]*)"/g,(all,spec)=>spec.startsWith('node:') ? all : `from ${JSON.stringify(pathToFileURL(resolve.resolve(spec)).href)}`);
}
let core = fs.readFileSync(path.join(original,'types-Cl_DXjhk.js'),'utf8');
const coreHash = createHash('sha256').update(core).digest('hex');
if (coreHash !== '0bb3a34508785bdc34626542f9358d398fd9f60fdaf4b48201dfdff2122f25fc') throw new Error('Unsupported installed DSH ACL core hash; refusing to patch');
core = imports(core,path.join(original,'types-Cl_DXjhk.js'));
core = replaceOne(core,'import { createHash } from "node:crypto";', 'import { createHash, randomBytes } from "node:crypto";\nconst ipcScopeSid = "S-1-4-" + Array.from({length:4}, () => randomBytes(4).readUInt32LE()).join("-") + "-2";\nexport { ipcScopeSid };');
core = replaceOne(core,'createLazyRequire("koffi", import.meta.url)',`createLazyRequire("koffi", ${JSON.stringify(pathToFileURL(path.join(original,'types-Cl_DXjhk.js')).href)})`);
core = replaceOne(core,'const restrictingSids = buildRestrictingSids(mode ===', 'const ipcSidSlot = allocPtrSlot();\n\tif (!api.convertStringSidToSidW(ipcScopeSid, ipcSidSlot)) throwLastError$1(api, "ConvertStringSidToSidW", "IPC scope");\n\tconst ipcSid = decodePtr(ipcSidSlot);\n\ttry {\n\tconst restrictingSids = buildRestrictingSids([...(mode ===');
core = replaceOne(core,'\t\t...writeSids\n\t]);','\t\t...writeSids\n\t]), ipcSid]);');
core = replaceOne(core,'\treturn token;\n}\n//#endregion\n//#region lib/types/grant.js', '\treturn token;\n\t} finally { api.localFree(ipcSid); }\n}\n//#endregion\n//#region lib/types/grant.js');
let runner = fs.readFileSync(path.join(original,'runner.js'),'utf8');
const runnerHash = createHash('sha256').update(runner).digest('hex');
if (runnerHash !== '9159aaa995d417e5948dd1cc3d8cd40616270e320048e577c58a1c65be3f3a2d') throw new Error('Unsupported installed DSH runner hash; refusing to patch');
runner = imports(runner,path.join(original,'runner.js'));
runner = 'import { ipcScopeSid } from "./types-Cl_DXjhk.js";\n'+runner;
runner = replaceOne(runner,'\t\tconst child = sandbox.spawn({', '\t\tif (!api.setEnvironmentVariableW("DSH_PIPE_SCOPE_SID", ipcScopeSid)) fail("Cannot set IPC scope");\n\t\tif (!api.setEnvironmentVariableW("NODE_OPTIONS", '+JSON.stringify('--require="'+path.join(root,'preload.cjs').replaceAll('\\','/')+'"')+')) fail("Cannot set isolated preload");\n\t\tconst child = sandbox.spawn({');
fs.writeFileSync(path.join(out,'types-Cl_DXjhk.js'),core,'utf8');
fs.writeFileSync(path.join(out,'runner.js'),runner,'utf8');
fs.writeFileSync(path.join(out,'package.json'),JSON.stringify({type:'module'}),'utf8');
fs.writeFileSync(path.join(root,'.artifacts/source.json'),JSON.stringify({original,coreHash,runnerHash,asarHash:createHash('sha256').update(require('original-fs').readFileSync(install)).digest('hex')},null,2),'utf8');
console.log('Prepared isolated runner; installed files unchanged.');
