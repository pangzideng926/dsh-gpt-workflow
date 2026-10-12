param(
  [Parameter(Mandatory=$true)][string]$Repo,
  [Parameter(Mandatory=$true)][string]$BackupFile
)
$ErrorActionPreference = 'Stop'
# DSH 的原生沙箱需要对工作区根目录设置完整性标签；仅补当前用户的 WRITE_OWNER。
# 不递归、不改变所有者、不禁用沙箱，也不扩大成 FullControl。
$target = (Resolve-Path -LiteralPath $Repo).Path.TrimEnd('\', '/')
$gitRoot = (& git -C $target rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or (Resolve-Path -LiteralPath $gitRoot).Path.TrimEnd('\', '/') -ne $target) { throw 'Repo 必须是具体 Git 仓库根目录' }
$backup = [IO.Path]::GetFullPath($BackupFile)
if (Test-Path -LiteralPath $backup) { throw 'ACL 备份文件已存在，拒绝覆盖' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $target
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw '当前用户不是目录所有者；不自动修改' }
@{ path=$target; sddl=$acl.Sddl; at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $backup -Encoding utf8
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::TakeOwnership, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
Write-Output "已为当前用户补充仓库根目录 TakeOwnership；备份：$backup"
