import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanningResult } from '../src/planning-result.mjs';
const base={stage:'locate',status:'ready',title:'定位',questions:'',repos:['E:/repo'],reason:'实际代码',tasks:[],plan:''};
test('结构化结果必须符合当前阶段；缺问题或空方案不能视为可派发',()=>{
  assert.deepEqual(validatePlanningResult(base,'locate').repos,['E:/repo']);
  assert.throws(()=>validatePlanningResult(base,'plan'),/阶段不匹配/);
  assert.throws(()=>validatePlanningResult({...base,status:'needs_input'},'locate'),/补充的问题/);
  assert.throws(()=>validatePlanningResult({...base,stage:'plan'},'plan'),/缺少各仓库实施方案/);
  assert.throws(()=>validatePlanningResult({...base,stage:'legacy'},'legacy'),/缺少实施方案/);
  assert.throws(()=>validatePlanningResult({...base,extra:'unexpected'},'locate'));
  assert.throws(()=>validatePlanningResult({...base,reason:'x'.repeat(300001)},'locate'),/过大/);
});
