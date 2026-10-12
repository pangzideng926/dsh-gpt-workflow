import { z } from 'zod';

// 两个阶段在同一持久会话中共用工具定义；按当前阶段再次校验，不能靠自然语言决定派发。
const text = z.string().max(300000);
const schema = z.strictObject({
  stage: z.enum(['locate', 'plan', 'legacy']),
  status: z.enum(['ready', 'needs_input']),
  title: text,
  questions: text,
  repos: z.array(text).max(8),
  reason: text,
  tasks: z.array(z.strictObject({repo:text, title:text, plan:text})).max(8),
  plan: text,
});

export const planningTool = {
  type: 'function',
  name: 'submit_planning_result',
  description: '将当前阶段的规划结果提交给本地工作流。只接收数据，不修改业务仓库、不启动开发。未使用的字符串填空、数组填 []；提交成功后必须用中文 Markdown 向用户说明结果和下一步。',
  inputSchema: z.toJSONSchema(schema),
};

export function validatePlanningResult(input, stage) {
  if (Buffer.byteLength(JSON.stringify(input) || '') > 300000) throw new Error('规划结果过大');
  const data = schema.parse(input);
  if (data.stage !== stage) throw new Error('规划结果阶段不匹配');
  if (!data.title.trim()) throw new Error('缺少规划标题');
  if (data.status === 'needs_input' && !data.questions.trim()) throw new Error('请明确需要补充的问题');
  if (data.status === 'ready') {
    if (stage === 'locate' && (!data.repos.length || data.repos.some(repo=>!repo.trim()) || !data.reason.trim())) throw new Error('缺少仓库路径或代码依据');
    if (stage === 'plan' && (!data.tasks.length || data.tasks.some(task=>!task.repo.trim() || !task.title.trim() || !task.plan.trim()))) throw new Error('缺少各仓库实施方案');
    if (stage === 'legacy' && !data.plan.trim()) throw new Error('缺少实施方案');
  }
  const {status, title, questions} = data;
  return {status, title, questions, ...(stage === 'locate' ? {repos:data.repos, reason:data.reason} : stage === 'plan' ? {tasks:data.tasks} : {plan:data.plan})};
}
