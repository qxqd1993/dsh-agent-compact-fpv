# 逐档跑测试（受限沙盒专用）
#
# 为什么需要它（2026-11-15 实测）：
#   `npm test` 用 `node --test`，它会为**每个测试档 spawn 一个子进程**并接管管道。
#   在 DSH 的受限沙盒里，子进程管道被禁 ⇒ 12 个档同时报 `spawn EPERM`，看起来像 12 处
#   真错。而 `node <档>` 在进程内跑 `node:test` 完全没问题——差别只在「谁来起进程」。
#
#   也试过 `--test-isolation=none`（不起子进程）：能跑，但**和致命检查不共存**——
#   任何一个档里 `process.exit()` 都会把整个 runner 一起带走，连别的档的结果都看不到。
#   而「缺依赖默认判红」恰恰要用非零退出。两条路只能选一条，这里选「每档一个进程」。
#
# 用法：
#   pwsh -NoProfile -File tools/run-tests.ps1              # 缺依赖判红（默认）
#   pwsh -NoProfile -File tools/run-tests.ps1 -AllowSkip   # 缺依赖的档记 SKIP
#
# 退出码：有任何档判红 ⇒ 1；全绿（含 SKIP）⇒ 0。
param(
  [switch]$AllowSkip
)

# 必须用 Continue：把原生命令的 stderr 重定向进变量时，Stop 会把整段脚本终止掉
# （实测：一个判红的档就能让后面的档全部不跑，而且一行结果都不打）。
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # 先构建：测试 import 的是 lib/*.js，不重编就会测到旧产物（2026-11-15 踩过）。
  #
  # 直接调 tsc 的入口，不走 `npx`：npx 会往 stderr 打 npm 配置警告，而
  # `$ErrorActionPreference='Stop'` 下把原生 stderr 重定向进变量会**直接终止脚本**
  # （实测：脚本只打出一行 npm warn 就 exit 1，看起来像编译失败）。少一个中间层，少一个雷。
  $tsc = Join-Path $root 'node_modules/typescript/bin/tsc'
  $build = & node $tsc -p tsconfig.json 2>&1
  if ($LASTEXITCODE -ne 0) {
    $build | Where-Object { $_ -match 'error TS' } | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    Write-Host '[FAIL] 编译失败，测试未开始' -ForegroundColor Red
    exit 1
  }

  if ($AllowSkip) { $env:DSH_ALLOW_TEST_SKIP = '1' }

  $rows = @()
  $failed = 0
  foreach ($file in Get-ChildItem tests/*.test.mjs | Sort-Object Name) {
    $output = (& node $file.FullName 2>&1) -join "`n"
    $code = $LASTEXITCODE
    $pass = if ($output -match 'ℹ pass (\d+)') { [int]$Matches[1] } else { 0 }
    $fail = if ($output -match 'ℹ fail (\d+)') { [int]$Matches[1] } else { 0 }
    $skipped = ($code -eq 0 -and $output -match '\[skip\]')
    if ($code -ne 0) { $failed++ }
    $rows += [pscustomobject]@{
      File = $file.Name
      Pass = $pass
      Fail = $fail
      State = if ($skipped) { 'SKIP' } elseif ($code -ne 0) { 'RED' } else { 'ok' }
    }
  }

  $rows | Format-Table -AutoSize

  $totalPass = ($rows | Measure-Object -Property Pass -Sum).Sum
  $totalFail = ($rows | Measure-Object -Property Fail -Sum).Sum
  $skips = @($rows | Where-Object State -eq 'SKIP' | ForEach-Object File)
  Write-Host ("断言 {0} 条：pass {1} / fail {2}；档数 {3}（红 {4}）" -f `
      ($totalPass + $totalFail), $totalPass, $totalFail, $rows.Count, $failed)
  if ($skips.Count -gt 0) { Write-Host ("跳过（没有跑任何断言）：{0}" -f ($skips -join ', ')) -ForegroundColor Yellow }

  if ($failed -gt 0) { exit 1 }
  exit 0
}
finally {
  if ($AllowSkip) { Remove-Item Env:\DSH_ALLOW_TEST_SKIP -ErrorAction SilentlyContinue }
  Pop-Location
}
