param([Parameter(Mandatory=$true)][string]$Zig)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path "$repoRoot/.artifacts" -Force | Out-Null
$env:ZIG_GLOBAL_CACHE_DIR = "$repoRoot/.artifacts/zig-cache"
& $Zig cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Werror -shared "$repoRoot/native/pipe-compat.c" -o "$repoRoot/.artifacts/pipe-compat.node" -ladvapi32
if ($LASTEXITCODE -ne 0) { throw "Native build failed: $LASTEXITCODE" }
& $Zig cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Werror "$repoRoot/native/security-probe.c" -o "$repoRoot/.artifacts/security-probe.exe" -ladvapi32
if ($LASTEXITCODE -ne 0) { throw "Security probe build failed: $LASTEXITCODE" }
