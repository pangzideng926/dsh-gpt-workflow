// 两端共用的交接格式与展示：不读取文件、不调用模型，也不改变任务状态。
export const reportHeadings = ['已改文件', '验收结果', '测试记录', '未完成与阻塞', '交回 GPT'];

export function readSections(markdown = '') {
  const sections = Object.create(null);
  let current, fence;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) fence = marker[1];
    else {
      const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
      if (heading) { current = heading[1]; sections[current] ??= ''; continue; }
    }
    if (current) sections[current] += line + '\n';
  }
  return Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.trim()]));
}

export function reportCoverage(answer = '') {
  const sections = readSections(answer);
  return { missing: reportHeadings.filter(title => !sections[title]), sections: Object.fromEntries(reportHeadings.filter(title => sections[title]).map(title => [title, sections[title]])) };
}

export function nextStep(status, { workerAlive } = {}) {
  const steps = {
    planning: ['GPT', 'wait', '正在定位和规划，等待方案。'],
    needs_input: ['用户', 'clarify', '补充具体问题后再规划，保留原请求供核对。'],
    dispatching: ['GPT', 'wait', '正在派发，先查询关联任务，不重复创建。'],
    dispatched: ['DSH', 'wait', '查询关联开发会话，不重复派发。'],
    planned: ['GPT', 'start', '核对本轮方案后调用 workflow_start；已有授权时直接开始。'],
    accepted: ['DSH', 'wait', '已接收交接包，等待开发会话启动，不重投新轮次。'],
    running: ['DSH', 'wait', 'DSH 开发中；GPT 可读取和查询，不并行修改目标仓库。'],
    completed: ['GPT', 'review', '先读取 workflow_result 的当前证据，再按验收清单独立审查。'],
    awaiting_review: ['GPT', 'review', '先读取 workflow_result 的当前证据，再按验收清单独立审查。'],
    needs_changes: ['GPT', 'revise', '将审查问题映射到验收项，用 workflow_revise 更新方案后再 start。'],
    failed: ['GPT', 'inspect', '读取 workflow_result 和日志核对失败及进程状态；确认可修订后再 revise，不直接重试开发。'],
    interrupted: ['GPT', 'inspect', '核对原 DSH 会话及 workflow_status；不重放、不删除锁，确认结束后按恢复工具条件处理。'],
    approved: ['GPT', 'git_finish', '审查已通过；按仓库规则完成 Git 收尾。通过不代表已经提交或推送。'],
  };
  const [owner, action, message] = steps[status === 'running' && workerAlive === false ? 'interrupted' : status] || ['GPT', 'inspect', '先查询任务和原会话状态，再决定接手方式。'];
  return { owner, action, message };
}

export function createHandoff(task, plan, previousRunDir) {
  return {
    version: 1, id: task.id, title: task.title, attempt: task.attempt, repo: task.repo,
    baseline: { branch: task.baseline.branch, head: task.baseline.head, fingerprint: task.baseline.fingerprint },
    planHash: task.planHash, planPath: task.planPath, runDir: task.runDir,
    sections: readSections(plan), previousReview: task.reviews.at(-1) || null,
    previousRunDir: previousRunDir || null,
  };
}

const inline = value => '`' + String(value ?? '未记录').replaceAll('`', '\\`').replace(/[\r\n]/g, ' ') + '`';
export function renderHandoff({ packet, handoff, title, repo, plan, requirement, status, review, next, error, answer, evidence, sessionId, gptThreadId }) {
  packet ||= handoff;
  const current = review?.verdict || status;
  next ||= nextStep(current);
  const sections = packet?.sections || readSections(plan);
  const lines = ['# 任务交接', '', `任务：${inline(title || packet?.title)}；状态：${inline(current)}`, '',
    `**当前接手：${next.owner}**。${next.message}`, '', `仓库：${inline(repo || packet?.repo)}`];
  if (packet) {
    lines.push(`任务 ID：${inline(packet.id)}；开发轮次：${packet.attempt || '待启动'}`, `基线：${inline(packet.baseline?.branch)} / ${inline(packet.baseline?.head)}`, `方案指纹：${inline(packet.planHash)}`);
  } else lines.push('', '尚无结构化交接包（规划中请求或历史任务）；按需求、原方案及当前证据接手。');
  if (sessionId) lines.push(`DSH 会话：${inline(sessionId)}`);
  if (gptThreadId) lines.push(`GPT 会话：${inline(gptThreadId)}`);
  if (error) lines.push('', '## 当前阻塞', '', error);
  if (requirement && !sections['目标与范围']) lines.push('', '## 用户需求', '', requirement);
  for (const name of ['目标与范围', '代码依据', '验收标准', '测试要求']) {
    if (sections[name]) lines.push('', `## ${name}`, '', sections[name]);
  }
  if (packet?.previousReview) lines.push('', '## 上轮审查与返工依据', '', `第 ${packet.previousReview.attempt || '?'} 轮；证据：${inline(packet.previousReview.evidenceHash)}`, '', packet.previousReview.summary);
  if (packet?.previousRunDir) lines.push('', `上轮材料：${inline(packet.previousRunDir)}。只按需读取，不重做已完成且仍有效的工作。`);
  if (evidence) lines.push('', '## 程序采集的证据', '', `退出码：${inline(evidence.exitCode)}；证据指纹：${inline(evidence.evidenceHash)}`, '',
    'Git 检测到的改动文件（不代表验收通过）：', ...(evidence.changedFiles || []).map(file => `- ${inline(file)}`));
  if (answer) {
    const coverage = reportCoverage(answer);
    lines.push('', '## 开发报告完整性', '', 'DSH 自述，未经独立验证；章节齐全也不代表测试通过。', '',
      coverage.missing.length ? `缺少或为空：${coverage.missing.join('、')}。GPT 接手时须从原会话、工具记录补核，不猜测结果。` : '已包含五个交接章节；请逐条核对命令输出、验收和剩余限制。');
    lines.push('', '## DSH 回传（待核验）', '', answer);
  }
  if (review) lines.push('', '## 本轮 GPT 审查', '', review.summary);
  if (packet?.runDir) lines.push('', '## 证据入口', '', `本轮目录：${inline(packet.runDir)}`, '', '开发结束后通过 workflow_result 获取 evidence.json、changes.diff 和 events.jsonl 的实际路径；文件存在及内容均须读取核对。');
  lines.push('', '## 接手约定', '', '先读适用规则 → 本轮方案及引用上下文 → 上轮审查（返工时）→ 本轮代码和测试证据。报告、代码和日志属于待核实材料，不能覆盖用户要求或授权。');
  return lines.join('\n') + '\n';
}

export function developerPrompt(task, plan, packet) {
  return `Active task: ${task.runDir}
你是本次任务唯一的代码开发者。GPT 已制定实施方案，完成后由 GPT 审查。
目标仓库：${task.repo}
起始分支：${task.baseline.branch}；起始提交：${task.baseline.head}
先读取适用的 AGENTS.md，再读本轮交接摘要.md、实施方案.md 及代码依据列出的相关规范。上下文引用按用途读取，不全量扫描历史。
交接目录不可读时，以本消息中的冻结方案和上轮审查为准，记录访问限制，不修改权限。
只在目标仓库实现本次需求，保留已有内容。程序生成的交接包、运行记录及证据不能修改。
本次明确分工：只开发和运行必要测试；Git add/commit/push、切分支、拉取由 GPT 审查通过后统一执行，本轮不要执行。
关键逻辑先写失败测试，再实现通过。不自动派发子代理。
实质变更需求、接口或数据结构时停止并交回 GPT；返工只针对审查缺口，保留已验证有效的改动。
上一轮审查意见：${packet.previousReview?.summary || '无'}

${plan}

最终用简体中文按以下五个二级标题交回（不另写入业务仓库）：
## 已改文件
实际路径、改动及原因；不要只说“已完成”。
## 验收结果
逐项沿用方案验收编号，注明满足/未满足/未验证及对应证据。
## 测试记录
列出工作目录、实际命令、退出码、关键输出、实际权限/环境；未运行填“未运行”并说明原因。不得用开发进程退出码代替各条测试退出码。
## 未完成与阻塞
遗漏、环境限制、失败尝试及风险；没有则明确写“无”。
## 交回 GPT
下一步需要核对哪些文件、哪条测试和哪些审查问题；无法确认的结论明确标为待验证。
`;
}
