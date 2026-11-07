# T约束 (dsh-tlock) 安装脚本 —— 给 Windows + DSH 用
# 用法：右键「使用 PowerShell 运行」，或在文件夹里执行
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 先看计划不写入：加 -DryRun

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

# 让中文在 Windows 控制台里正常显示
try { cmd /c chcp 65001 | Out-Null } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Say ""
Say "=============================================="
Say "  T约束 · dsh-tlock 安装程序"
Say "=============================================="

# ── 1. 找到 DSH 安装位置（为了用它自带的 pnpm 和 node）────────────
$dshExe = $null
try {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DSH*' } | Select-Object -First 1
  if ($proc -and $proc.Path) { $dshExe = $proc.Path }
} catch { }
if (-not $dshExe) {
  foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DSH NEXT\DSH NEXT.exe'),
      'D:\DeepSeekHarness\DSH NEXT\DSH NEXT.exe',
      (Join-Path $env:ProgramFiles 'DSH NEXT\DSH NEXT.exe'))) {
    if (Test-Path $c) { $dshExe = $c; break }
  }
}
if ($dshExe) { Ok "DSH: $dshExe" } else { Warn "没找到 DSH 安装位置（不影响装插件，只是自动安装依赖可能失败）" }

$pnpmCjs = $null
if ($dshExe) {
  $cand = Join-Path (Split-Path -Parent $dshExe) 'resources\app.asar.unpacked\node_modules\pnpm\bin\pnpm.cjs'
  if (Test-Path $cand) { $pnpmCjs = $cand; Ok "pnpm: $cand" }
}

$nodeExe = $null
try { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source } catch { }
if (-not $nodeExe -and $dshExe) {
  $cand = Join-Path (Split-Path -Parent $dshExe) 'resources\app.asar.unpacked\node_modules\node\bin\node.exe'
  if (Test-Path $cand) { $nodeExe = $cand }
}
if ($nodeExe) { Ok "node: $nodeExe" } else { Warn "没找到 node.exe" }

$dshCli = $null
try { $dshCli = (Get-Command dsh -ErrorAction SilentlyContinue).Source } catch { }
if ($dshCli) { Ok "dsh CLI: $dshCli" }

# ── 2. 找 profile（插件装到哪个 profile）──────────────────────────
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'
if (-not (Test-Path $profilesRoot)) {
  Fail "找不到 $profilesRoot —— 你是不是还没打开过 DSH？先启动一次 DSH 再装。"
  exit 1
}

$found = @()
foreach ($dir in Get-ChildItem $profilesRoot -Directory) {
  $pkg = Join-Path $dir.FullName 'package.json'
  if (-not (Test-Path $pkg)) { continue }
  try { $j = Get-Content $pkg -Raw | ConvertFrom-Json } catch { continue }
  if ($j.dsh -and $j.dsh.profile -and $j.dsh.profile.bundles) {
    $found += [pscustomobject]@{ Name = $dir.Name; Path = $dir.FullName; Bundles = @($j.dsh.profile.bundles) }
  }
}
if ($found.Count -eq 0) {
  Fail "在 $profilesRoot 里没有找到可用的 profile。"
  exit 1
}

$profile = $null
foreach ($want in @('desktop', 'web')) {
  $hit = $found | Where-Object { $_.Name -eq $want } | Select-Object -First 1
  if ($hit) { $profile = $hit; break }
}
if (-not $profile) { $profile = $found[0] }
Ok ("profile: " + $profile.Name + "  (" + $profile.Path + ")")
Say ("     已装插件数: " + ($profile.Bundles.Count))

$pluginTarget = Join-Path $dshHome 'plugins\dsh-tlock'
$installedCopy = Join-Path $profile.Path 'node_modules\dsh-tlock'

# ── 3. 计划 ─────────────────────────────────────────────────────
Say ""
Say "计划："
Say ("  1) 复制插件 -> " + $pluginTarget)
Say ("  2) 在该 profile 里安装依赖 -> " + $installedCopy)
Say ("  3) 把 dsh-tlock 加进 dsh.profile.bundles")
Say ("  4) 重启 DSH 后生效")

if ($DryRun) {
  Say ""
  Warn "DryRun：没有写入任何文件。"
  exit 0
}

# ── 4. 复制插件文件 ─────────────────────────────────────────────
if (-not (Test-Path $pluginTarget)) { New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null }
foreach ($item in @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
  $p = Join-Path $src $item
  if (Test-Path $p) { Copy-Item $p (Join-Path $pluginTarget $item) -Force }
}
$libSrc = Join-Path $src 'lib'
$libDst = Join-Path $pluginTarget 'lib'
if (-not (Test-Path $libDst)) { New-Item -ItemType Directory -Path $libDst -Force | Out-Null }
Copy-Item (Join-Path $libSrc '*') $libDst -Force
Ok "插件文件已复制"

# ── 5. 在 profile 里装依赖 ──────────────────────────────────────
$spec = 'file:' + ($pluginTarget -replace '\\', '/')
Push-Location $profile.Path
try {
  if ($nodeExe -and $pnpmCjs) {
    Say "  用 DSH 自带的 pnpm 安装…"
    & $nodeExe $pnpmCjs add $spec
    if ($LASTEXITCODE -ne 0) { Warn "pnpm 退出码 $LASTEXITCODE" }
  } elseif ($dshCli) {
    Say "  用 dsh CLI 安装…"
    & $dshCli plugin --profile $profile.Name add $spec
    if ($LASTEXITCODE -ne 0) { Warn "dsh plugin 退出码 $LASTEXITCODE" }
  } else {
    Warn "没有 pnpm / dsh CLI，退化为手工复制到 node_modules"
    if (-not (Test-Path $installedCopy)) { New-Item -ItemType Directory -Path $installedCopy -Force | Out-Null }
    foreach ($item in @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
      $p = Join-Path $src $item
      if (Test-Path $p) { Copy-Item $p (Join-Path $installedCopy $item) -Force }
    }
    $d = Join-Path $installedCopy 'lib'
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Copy-Item (Join-Path $libSrc '*') $d -Force
    Ok "已手工复制"
  }
} finally {
  Pop-Location
}

# ── 6. 注册到 dsh.profile.bundles ───────────────────────────────
$pkgPath = Join-Path $profile.Path 'package.json'
Copy-Item $pkgPath ($pkgPath + '.bak-tlock') -Force
try {
  $j = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $bundles = @($j.dsh.profile.bundles)
  if ($bundles -notcontains 'dsh-tlock') {
    $j.dsh.profile.bundles = @($bundles + 'dsh-tlock')
    $json = $j | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Ok "已加入 dsh.profile.bundles"
  } else {
    Ok "dsh.profile.bundles 里已经有了"
  }
} catch {
  Fail ("改 package.json 失败：" + $_.Exception.Message)
  Warn ("原文件备份在 " + $pkgPath + ".bak-tlock")
  exit 1
}

# ── 7. 可选：桌面控制台 ─────────────────────────────────────────
$deskExe = Join-Path $src 'desktop\TLock.exe'
if (Test-Path $deskExe) {
  $deskDir = Join-Path $env:LOCALAPPDATA 'TLock'
  try {
    if (-not (Test-Path $deskDir)) { New-Item -ItemType Directory -Path $deskDir -Force | Out-Null }
    Copy-Item $deskExe (Join-Path $deskDir 'TLock.exe') -Force
    $ico = Join-Path $src 'desktop\icon.ico'
    if (Test-Path $ico) { Copy-Item $ico (Join-Path $deskDir 'icon.ico') -Force }
    Ok ("桌面控制台已放到 " + (Join-Path $deskDir 'TLock.exe') + "（可选，双击即可）")
  } catch {
    Warn ("桌面控制台没复制成功（可能正在运行）：" + $_.Exception.Message)
    Warn ("可以手动把 desktop\TLock.exe 复制到 " + $deskDir)
  }
}

Say ""
Say "=============================================="
Ok "装好了。现在【完全退出 DSH 再重新打开】"
Say "  重开后在页面右下角能看到黑色方块悬浮球，点开就是面板。"
Say "  找不到球？检查：设置 -> 插件 里有没有 T约束；或看 %USERPROFILE%\.dsh\storages\dsh-tlock\status.json 有没有生成。"
Say "=============================================="
