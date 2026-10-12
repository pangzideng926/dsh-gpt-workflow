# GPT × DSH 开发协作

本地 Codex 插件：GPT 读取代码并生成一份实施文档，DeepSeek Harness 执行开发，完成后回到当前 GPT 会话审查。使用现有 Codex 会话与 DSH 模型配置，不额外接入 OpenAI API。

## 使用

在安装插件后的新聊天中输入：

> 用 dsh-gpt-workflow 处理 E:/Eworkspace/具体子仓库 的这个需求：……。GPT 先出实施文档，DSH 开发，完成后由 GPT 审查。

流程：`planned → running → awaiting_review → approved / needs_changes`。返工会更新同一份实施文档并保留每轮证据。退出异常、超时或缺少有效最终结果进入 `failed`。

GPT 在当前聊天保持等待并查询状态，完成后读取 diff、新文件和实际测试证据，记录审查结论。**关闭聊天后 DSH 可以继续运行，但此版不会自动唤醒 GPT**；重新打开聊天，让 GPT 查询并继续即可。只有审查通过，GPT 才按目标仓库规则统一 Git 收尾。

## 本地安装

要求 Node.js 22+、Git、已完成模型配置的 DSH headless。已实测 DSH `0.1.7-alpha.2`；DSH 仍为预览版，升级后应复测 headless JSON 协议。

```powershell
cd E:/Eworkspace/dsh-gpt-workflow
npm ci
npm test
npm run build
codex plugin marketplace add E:/Eworkspace/dsh-gpt-workflow
codex plugin add dsh-gpt-workflow@dsh-gpt-local
```

构建目录 `.runtime/plugin` 含独立运行文件，无需复制 `node_modules` 或 `.git`。更新源码后重新构建，再通过 Codex 的移除/安装流程更新本插件，不直接修改缓存。

```powershell
codex plugin remove dsh-gpt-workflow@dsh-gpt-local
codex plugin add dsh-gpt-workflow@dsh-gpt-local
```

安装后新开聊天加载 Skill 和 MCP 工具。如工具尚未加载，可运行 `node src/cli.mjs <动作> <参数.json>`；安装包对应 `dist/cli.mjs`。动作和参数对应下表的工具名（去掉 `workflow_` 前缀）；`-` 表示从 stdin 读 JSON。

## 工具

| 工具 | 作用 |
| --- | --- |
| `workflow_create` | 保存 GPT 实施方案，记录仓库、分支和代码基线 |
| `workflow_start` | 取得仓库独占锁，后台启动 DSH |
| `workflow_status` / `workflow_list` | 查询与跨聊天续接 |
| `workflow_result` | 返回 DSH 说明、退出码、代码快照、差异及工具事件路径 |
| `workflow_review` | GPT 根据证据提交通过或返工结论 |
| `workflow_revise` | 修改方案并准备下一轮开发 |
| `workflow_recover` | 监督进程异常消失且记录的 DSH 进程也已退出时恢复 |

实施文档要求五个 `##` 标题：目标与范围、代码依据、实施步骤、验收标准、测试要求。模板在 `skills/dsh-gpt-workflow/references/实施方案模板.md`。

## 状态与运行边界

- 初次任务只接受干净、已有提交、处于命名分支的具体 Git 仓库；不会自动提交、stash 或清理既有改动。需要保留他人改动时使用独立工作树。
- 创建和启动之间会核对基线；审查结论必须绑定最新证据哈希和当前代码快照。
- 锁覆盖插件内同一仓库的开发及待审查阶段；它是协作锁，不能阻止外部编辑器、其它工具或不遵从指令的模型写文件，也不是操作系统沙箱。
- DSH 只开发，Git 收尾交给 GPT；检测到 DSH 提交或切分支则标记失败并保留证据。
- 每轮单独保存提示词、实施文档、工具事件、最终回答、退出码、diff 和未跟踪文件哈希。忽略的文件不纳入 Git 证据；审查者仍需核对任务要求及真实运行环境。
- 不保存模型 thinking 事件。运行日志可能含代码和工具输出，仅保存在本机用户目录，勿提交到共享仓库。
- 默认最长执行 30 分钟，超时终止本次进程树。异常监督进程不会自动解锁。恢复依赖记录的 PID；PID 不完整或复用时保守拒绝，需人工核查。
- MCP 客户端断开不终止独立 worker。进程退出成功仅表示待审查；测试失败、环境缺失或需求阻塞仍需 GPT 根据报告决定。
- 暂不提供网页面板、多任务并行写同一仓库、自动唤醒关闭的聊天或无人值守 Git 推送。

## 可选环境变量

| 名称 | 默认 / 含义 |
| --- | --- |
| `DSH_WORKFLOW_HOME` | `~/.codex/dsh-gpt-workflow`，任务持久目录 |
| `DSH_WORKFLOW_PROFILE` | `headless`，须支持 headless 参数的 DSH profile |
| `DSH_WORKFLOW_BIN` | 可选：DSH 的 JS 入口或可执行文件绝对路径；Windows 自动识别 Volta/npm 安装，拒绝 cmd/bat 包装器 |
| `DSH_WORKFLOW_TIMEOUT_MS` | `1800000`，每轮超时，允许 1000～86400000 |

认证沿用本机 DSH 配置；不要在参数、实施文档或插件文件中写入密钥。此插件不调整 DSH 权限/沙箱。

## 验证

`npm test` 使用离线 DSH 替身验证锁、状态、失败处理、修订和 MCP 通信，不调用模型。真实冒烟需显式运行（会使用 DSH 额度）：

```powershell
node scripts/smoke-real.mjs E:/Eworkspace/.tmp/某个不存在的演示目录
```

脚本创建独立示例仓库，让真实 DSH 编写标签规范化函数与测试。它只启动开发，审查必须读取证据后由 GPT 完成。

2026-10-12 本机实测：真实 DSH 写出实现与测试并正确交回待审查；DSH 的 Windows shell 沙箱报告 `SetNamedSecurityInfoW ... grantWrite` 失败，无法运行测试。GPT 独立执行 5 项测试全部通过。该环境限制仍存在，不能把它表述为 DSH 已完成红绿测试。
