import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('GPT 与禅道展开互斥，保留草稿并清理事件订阅', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/receiver-panel.js', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const document = new EventTarget();
  const effects = [], values = [], cleanups = [];
  let index = 0, plugin, component;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useEffect(fn) { effects.push(fn); }, useMemo: fn => fn(), useRef: value => ({ current: value }),
  };
  vm.runInNewContext(bundled.outputFiles[0].text, { document, CustomEvent, window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => react); } } }, setInterval: () => 1, clearInterval() {}, AbortSignal, fetch: () => new Promise(() => {}) });
  plugin.apply({ slots: { inject: (_, fn) => fn(), register: (_, fn) => { component = fn(); } } });
  function render() { index = 0; effects.length = 0; const tree = component.type(component.props); for (const fn of effects) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); } return tree; }
  const tree = render();
  const button = tree.children.find(node => node?.props?.className === 'gwr-launcher');
  let announced = '';
  document.addEventListener('dsh-workbench:open', event => { announced = event.detail?.id; });
  button.props.onClick(); render();
  assert.equal(announced, 'gpt-workflow-receiver', 'GPT 展开必须通知禅道');
  // 用户已填写但未提交的需求不得因切换而丢失。
  values[5] = true; values[7] = '尚未提交的需求';
  document.dispatchEvent(new CustomEvent('dsh-workbench:open', { detail: { id: 'zentao-workbench' } }));
  assert.equal(values[0], false, '禅道展开必须收起 GPT');
  assert.equal(values[7], '尚未提交的需求');
  values[0] = true;
  document.dispatchEvent(new CustomEvent('dsh-workbench:open', { detail: { id: 'unrelated-plugin' } }));
  assert.equal(values[0], true);
  for (const cleanup of cleanups) cleanup();
  document.dispatchEvent(new CustomEvent('dsh-workbench:open', { detail: { id: 'zentao-workbench' } }));
  assert.equal(values[0], true, '卸载必须解除事件订阅');
});
