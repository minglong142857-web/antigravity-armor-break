# 刷新 Antigravity 的 OAuth token（离线通道用）
# 原理：起一个临时 language_server（走 relay + 系统代理），它会自己 refresh token，
#       relay 从请求头把新 token 抓进 run\last_token.json，然后关掉临时实例。
[CmdletBinding()]
param([int]$TimeoutSec = 45)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LsExe = "$env:LOCALAPPDATA\Programs\antigravity\resources\bin\language_server.exe"
$Token = Join-Path $Root 'run\last_token.json'
$Port  = 8787

# 1) 代理（Go 只认环境变量，不认 WinINET）
if (-not $env:HTTPS_PROXY) {
  $sys = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
  if ($sys) { $env:HTTPS_PROXY = "http://$sys"; $env:HTTP_PROXY = "http://$sys" }
}
if (-not $env:NO_PROXY) { $env:NO_PROXY = '127.0.0.1,localhost' }

# 2) relay 必须在听
$lis = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if (-not $lis) {
  Write-Host "[refresh] relay 未运行，先起 relay"
  & (Join-Path $Root 'bin\start-relay.ps1') -Mode inject | Out-Host
  Start-Sleep -Milliseconds 800
}

$started = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 5

# 3) 起临时 LS（指向 relay）
$csrf = [guid]::NewGuid().ToString()
$argList = @(
  '--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
  '--override_ide_version', '2.32.1', '--https_server_port', '0',
  '--csrf_token', $csrf, '--app_data_dir', 'antigravity-broken',
  '--api_server_url', "http://127.0.0.1:$Port",
  '--cloud_code_endpoint', "http://127.0.0.1:$Port",
  '--inference_api_server_url', "http://127.0.0.1:$Port"
)
$ls = Start-Process -FilePath $LsExe -ArgumentList $argList -PassThru -WindowStyle Hidden

# 4) 等 token 更新
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  if (Test-Path $Token) {
    try {
      $t = Get-Content $Token -Raw | ConvertFrom-Json
      if ([int]$t.ts -ge $started) { $ok = $true; break }
    } catch { }
  }
  if ($ls.HasExited) { break }
}
try { Stop-Process -Id $ls.Id -Force -ErrorAction SilentlyContinue } catch { }

if ($ok) {
  $age = [math]::Round(((Get-Date) - [datetimeoffset]::FromUnixTimeSeconds($t.ts).LocalDateTime).TotalMinutes, 1)
  Write-Host "[refresh] token 已刷新（年龄 $age 分钟，长度 $($t.token.Length)）"
  exit 0
} else {
  Write-Host "[refresh] 未拿到新 token：检查 relay 是否在听 :$Port、代理是否可用、网络是否可达 Google"
  exit 1
}
