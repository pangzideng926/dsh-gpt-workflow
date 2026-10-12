# Windows 受限管道兼容实验

解决 DSH Windows ACL 沙箱内 Node 默认测试子进程的 `spawn EPERM`。这是**独立验证原型，未启用到插件或 DSH 正式运行时**。

当前支持 Windows x64、已验证的 DSH 0.2.0-rc.2 源码快照、Node 22.22.2 / 24.21.0。准备脚本锁定两份安装源码的 SHA256；其他版本拒绝修改。无需管理员权限，不安装服务，不更改全局环境或业务任务。

## 原理

DSH 保留原有 Low 完整性、`WRITE_RESTRICTED` 令牌、工作区与临时目录授权，只给每个独立运行器加入随机的 IPC SID。原生兼容模块让 libuv 新建的本进程命名管道显式允许该 IPC SID；不向目录授予它，不加入 Authenticated Users / INTERACTIVE 等宽泛身份。

实验通过 Node-API 模块适配当前 Node 进程的导入表，仅处理默认安全描述符、当前进程 `uv` 管道名和 `FIRST_PIPE_INSTANCE`。`NODE_OPTIONS` 仅由实验运行器设置给本次后代，默认 `node --test` 参数和真正的测试子进程保持不变。加载失败直接报错，不自动切换不受限执行。

## 复现

从本目录运行 PowerShell 7。Zig 0.15.2 Windows x64 压缩包来自 [Zig 官方发布索引](https://ziglang.org/download/index.json)，SHA256：`3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c`。解压在独立工具目录，不修改 PATH。

```powershell
$ErrorActionPreference = 'Stop'
# 使用正式安装中只读取得的原始 runner 证明默认测试确实失败。
node test/baseline.cjs
if ($LASTEXITCODE -ne 0) { throw '基线与预期不符' }
# 参数替换为独立目录中 zig.exe 的完整路径。
./scripts/build.ps1 -Zig '完整路径/zig.exe'
node scripts/prepare-host.cjs
if ($LASTEXITCODE -ne 0) { throw '独立运行器准备失败' }
node test/run-matrix.cjs
if ($LASTEXITCODE -ne 0) { throw '兼容或权限回归失败' }
```

`prepare-host.cjs` 使用已安装 Electron 的 `ELECTRON_RUN_AS_NODE=1` 命令行模式，只读访问 app.asar。它不启动界面。生成的运行器副本和原生模块位于 `.artifacts/`，系统临时目录中的工作区、外部 canary 均为测试专用。运行器自动撤销并删除自己的私有临时目录；测试工作区保留以便核对证据。

结果见 `.artifacts/baseline.json`、`source.json`、`matrix.json`。测试矩阵要求两代 Node 都已存在，缺失时失败，不跳过后报告成功。所有运行器仅使用测试专用工作区。

## 限制与后续接入

- 原型没有修改安装包、插件配置、现有会话或默认命令。正常使用中的 DSH 仍未应用此修复。
- 导入表适配只是验证路径；正式发布优先使用经维护的 libuv/Node 原生补丁，并审查加载、升级与撤回策略。这里不自动安装或热更新。
- 仅验证 Node 的管道子进程，不意味着任意 Windows 程序都已兼容。
- `WRITE_RESTRICTED` 提供写入限制，并非跨会话读取保密性。本实验验证跨会话**写入拒绝**，不宣称强 IPC 读取隔离。
- 安全边界仍受 DSH 原有 Everyone、硬链接等已知限制影响；本次没有扩大其限制身份列表中的普通组。

详细目标见 [设计与验收](设计与验收.md)，实测结果见 [验证记录](验证记录.md)。上游说明见 [DSH Windows ACL 已知限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md#known-limitations-and-deferred-work)；管道访问检查见 [Microsoft 命名管道安全文档](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。
