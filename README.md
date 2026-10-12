# GPT × DSH 开发协作

双端本地插件：GPT 读取代码并生成实施文档，DSH 接收插件在桌面界面创建开发会话，完成后将代码和测试证据交回 GPT 审查。使用现有 Codex 会话与 DSH 模型配置，不额外接入 OpenAI API。

## 使用

在安装插件后的新聊天中输入：

> 用 dsh-gpt-workflow 处理 E:/Eworkspace/具体子仓库 的这个需求：……。GPT 先出实施文档，DSH 开发，完成后由 GPT 审查。

流程：`planned → running → awaiting_review → approved / needs_changes`。返工更新同一份实施文档，每轮创建一个独立 DSH 会话，保留全部历史。相同轮次重复投递不会重复创建会话。

DSH 右下角 **GPT** 按钮打开悬浮工作台（位于禅道按钮旁边）：可切换任务、查看实施方案/开发结果/GPT 审查，并一键打开开发会话。面板不提供“自己批准”按钮，审查结论由 GPT 端同步。面板打开时每 2.5 秒更新。

三个详情页签均按 Markdown 渲染，支持标题、表格、代码块、列表、引用和行内代码。长内容可滚动，宽表格与代码块可横向滚动；原始 HTML 按文字显示，图片仅显示说明。前端更新后在 DSH 中按 `Ctrl+R` 加载。

GPT 在当前聊天保持等待并查询状态，完成后读取 diff、新文件和实际测试证据，记录审查结论。**关闭聊天后 DSH 可以继续运行，但此版不会自动唤醒 GPT**；重新打开聊天，让 GPT 查询并继续即可。只有审查通过，GPT 才按目标仓库规则统一 Git 收尾。

## 本地安装

要求 Node.js 22+、Git、已完成模型配置并保持运行的 DSH 桌面版。已实测桌面版 `0.2.0-rc.2`；使用原生宿主服务，DSH 升级后应复测。

```powershell
cd E:/Eworkspace/dsh-gpt-workflow
npm ci
npm test
npm run build
# 使用桌面安装附带的 CLI，避免 PATH 中旧版 CLI 操作 desktop profile。
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add E:/Eworkspace/dsh-gpt-workflow/dsh-receiver
codex plugin marketplace add E:/Eworkspace/dsh-gpt-workflow
codex plugin add dsh-gpt-workflow@dsh-gpt-local
```

构建输出分别是 `.runtime/plugin`（Codex）与 `dsh-receiver/lib`（DSH）。本地 link 安装后须保留源码仓库与构建目录。升级 DSH 插件后，在没有运行中任务时完整重启 DSH；Codex 通过受支持的安装命令更新缓存，不手动改缓存。

```powershell
codex plugin add dsh-gpt-workflow@dsh-gpt-local
```

安装后新开聊天加载 Skill 和 MCP 工具。如工具尚未加载，可运行 `node src/cli.mjs <动作> <参数.json>`；安装包对应 `dist/cli.mjs`。动作和参数对应下表的工具名（去掉 `workflow_` 前缀）；`-` 表示从 stdin 读 JSON。

## 工具

| 工具 | 作用 |
| --- | --- |
| `workflow_create` | 保存 GPT 实施方案，记录仓库、分支和代码基线 |
| `workflow_start` | 检查 DSH 接收端在线，取得仓库锁并向桌面派单 |
| `workflow_status` / `workflow_list` | 查询与跨聊天续接 |
| `workflow_result` | 返回 DSH 说明、退出码、代码快照、差异及工具事件路径 |
| `workflow_review` | GPT 根据证据提交通过或返工结论 |
| `workflow_revise` | 修改方案并准备下一轮开发 |
| `workflow_recover` | 监督进程异常消失后，向接收端确认开发结束再恢复 |

实施文档要求五个 `##` 标题：目标与范围、代码依据、实施步骤、验收标准、测试要求。模板在 `skills/dsh-gpt-workflow/references/实施方案模板.md`。

## 状态与运行边界

- 初次任务只接受干净、已有提交、处于命名分支的具体 Git 仓库；不会自动提交、stash 或清理既有改动。需要保留他人改动时使用独立工作树。
- 创建和启动之间会核对基线；审查结论必须绑定最新证据哈希和当前代码快照。
- 锁覆盖插件内同一仓库的开发及待审查阶段；它是协作锁，不能阻止外部编辑器、其它工具或不遵从指令的模型写文件，也不是操作系统沙箱。
- DSH 只开发，Git 收尾交给 GPT；检测到 DSH 提交或切分支则标记失败并保留证据。
- 每轮单独保存提示词、实施文档、工具事件、最终回答、退出码、diff 和未跟踪文件哈希。忽略的文件不纳入 Git 证据；审查者仍需核对任务要求及真实运行环境。
- 不保存模型 thinking 事件。运行日志可能含代码和工具输出，仅保存在本机用户目录，勿提交到共享仓库。
- 默认最长执行 30 分钟，超时只取消本次 DSH 会话并等待空闲，不终止桌面应用。监督进程异常、连接不明或宿主重启后的 `interrupted` 均保留锁；不会自动重放。此 MVP 对宿主中途重启需人工核对原会话。
- MCP 客户端断开不终止独立 worker。进程退出成功仅表示待审查；测试失败、环境缺失或需求阻塞仍需 GPT 根据报告决定。
- 审查结论先可靠保存在 GPT 端，再同步到 DSH 面板。同步失败会返回 `reviewDelivery: pending...`；重试完全相同的 review 参数可补发，不重新批准或开发。
- 接收端只监听 `127.0.0.1` 随机端口，使用随机令牌，并拒绝浏览器 Origin。令牌与接收记录位于 `~/.dsh/gpt-workflow-receiver`，不进入源码或输出。面板使用 DSH 同源只读接口，不能派单或批准任务。
- 暂不支持跨机器派单、多任务并行写同一仓库、自动唤醒关闭的聊天或无人值守 Git 推送。

## 可选环境变量

| 名称 | 默认 / 含义 |
| --- | --- |
| `DSH_WORKFLOW_HOME` | `~/.codex/dsh-gpt-workflow`，任务持久目录 |
| `DSH_WORKFLOW_RECEIVER_FILE` | 可选：接收端连接文件绝对路径，默认 `~/.dsh/gpt-workflow-receiver/connection.json` |
| `DSH_WORKFLOW_BIN` | 兼容模式：显式设置后使用旧 headless 路径，主要用于离线测试；正常桌面模式不要设置 |
| `DSH_WORKFLOW_PROFILE` | 仅旧 headless 兼容模式使用，默认 `headless` |
| `DSH_WORKFLOW_TIMEOUT_MS` | `1800000`，每轮超时，允许 1000～86400000 |

认证沿用本机 DSH 配置；不要在参数、实施文档或插件文件中写入密钥。新开发会话采用 `workspace-write`，权限申请留在 DSH 原生界面处理，插件不会自动批准提权。

Windows 若出现 `SetNamedSecurityInfoW ... grantWrite`，先确认具体仓库 ACL。可用 `scripts/repair-windows-acl.ps1 -Repo <仓库绝对路径> -BackupFile <新的备份文件绝对路径>`：只对当前用户拥有的 Git 根目录补充 `TakeOwnership`，备份原 SDDL，不递归、不改所有者。此操作只解决目录标签权限，**不能消除受限沙箱的子进程管道 `spawn EPERM` 限制**。测试命令仍须按实际结果判断，不能把完全权限下的通过记成受限沙箱通过。

## 验证

`npm test` 验证鉴权、持久化去重、失败/中断、审查同步、桌面传输、仓库锁、修订和 MCP 通信，不调用模型。真实冒烟需显式运行（会使用 DSH 额度）：

```powershell
node scripts/smoke-real.mjs E:/Eworkspace/.tmp/某个不存在的演示目录
```

脚本创建独立示例仓库，让真实 DSH 编写标签规范化函数与测试。它只启动开发，审查必须读取证据后由 GPT 完成。

脚本支持 `--prepare`，只创建干净仓库和方案，便于先核对环境，然后使用 CLI start 派单。具体真实验证及剩余限制见 `docs/验证记录.md`。
