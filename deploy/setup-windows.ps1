# One-shot setup on an always-on Windows box. Run in an elevated PowerShell (Run as administrator)
# from anywhere, after cloning the repo. Idempotent: re-run after `git pull` to rebuild and restart.
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   & "$HOME\brain-mcp\deploy\setup-windows.ps1"

$ErrorActionPreference = "Stop"
$AppDir = if ($env:APP_DIR) { $env:APP_DIR } else { Join-Path $HOME "brain-mcp" }
$TaskName = "brain-mcp"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run this in an elevated PowerShell (Run as administrator)." -ForegroundColor Red; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or [int](node -p 'process.versions.node.split(".")[0]') -lt 22) {
  Write-Host "Node 22+ is required. Install it with:  winget install OpenJS.NodeJS.LTS   then reopen PowerShell." -ForegroundColor Red; exit 1
}
if (-not (Test-Path (Join-Path $AppDir "package.json"))) {
  Write-Host "Expected brain-mcp at $AppDir (set APP_DIR to override). Clone it first:" -ForegroundColor Red
  Write-Host "  git clone https://github.com/debashishthakur/brain-mcp.git $AppDir"; exit 1
}

Set-Location $AppDir

# Vault location, capture folder and public hostname, from brain.config.json.
# vaultPath is resolved relative to the config file, the same way the server resolves it.
$Config = Get-Content (Join-Path $AppDir "brain.config.json") -Raw | ConvertFrom-Json
$VaultDir = if ([System.IO.Path]::IsPathRooted($Config.vaultPath)) { $Config.vaultPath } else { [System.IO.Path]::GetFullPath((Join-Path $AppDir $Config.vaultPath)) }
$CaptureDir = if ($Config.captureDir) { $Config.captureDir } else { "Captures" }
$PublicHost = if ($Config.auth.publicUrl) { ([Uri]$Config.auth.publicUrl).Host } else { "brain.example.com" }
if (-not (Test-Path $VaultDir)) {
  Write-Host "The vault in brain.config.json does not exist: $VaultDir" -ForegroundColor Red; exit 1
}

Write-Host "== installing dependencies and building"
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit 1 }
npm run build --silent
if ($LASTEXITCODE -ne 0) { exit 1 }
npm prune --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit 1 }
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "data"), (Join-Path $AppDir "logs"), (Join-Path $VaultDir $CaptureDir) | Out-Null

Write-Host "== keeping the machine awake (no sleep, no hibernate, lid close ignored)"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>$null
powercfg /setactive SCHEME_CURRENT

Write-Host "== registering the '$TaskName' task (starts at boot, no login needed, restarts on failure)"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\deploy\start-oauth.cmd`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
}

$configured = (node dist\index.js auth status) -match "login configured: True|login configured: true"
if (-not $configured) {
  Write-Host ""
  Write-Host "== login is not configured yet. Run this next and scan the QR code with your authenticator app:" -ForegroundColor Yellow
  Write-Host "   cd $AppDir; node dist\index.js auth init"
  Write-Host "   Start-ScheduledTask -TaskName $TaskName"
} else {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  try { Invoke-RestMethod http://127.0.0.1:3737/healthz | ConvertTo-Json -Compress } catch { Write-Host "server not answering yet; check $AppDir\logs\service.log" -ForegroundColor Yellow }
}

@"

== Cloudflare Tunnel (once, in this same elevated PowerShell). Hostname from auth.publicUrl: $PublicHost
  winget install --id Cloudflare.cloudflared -e
  cloudflared tunnel login                        # opens a browser; pick the domain $PublicHost belongs to
  cloudflared tunnel create brain                 # prints the tunnel id
  cloudflared tunnel route dns brain $PublicHost
  # write the config for the Windows service (it runs as SYSTEM, so it reads from the system profile):
  `$id = "<tunnel id>"
  `$sys = "C:\Windows\System32\config\systemprofile\.cloudflared"
  New-Item -ItemType Directory -Force `$sys | Out-Null
  Copy-Item "`$HOME\.cloudflared\`$id.json" `$sys
  (Get-Content "$AppDir\deploy\cloudflared-config.yml") -replace "__TUNNEL_ID__", `$id -replace "__HOME__/.cloudflared", `$sys.Replace("\","/") -replace "brain\.example\.com", "$PublicHost" | Set-Content "`$sys\config.yml" -Encoding ascii
  cloudflared service install
  Start-Service cloudflared
  Invoke-RestMethod https://$PublicHost/healthz  # should answer from this box

== Useful afterwards
  Get-ScheduledTask brain-mcp | Get-ScheduledTaskInfo     # last run / result
  Get-Content $AppDir\logs\service.log -Tail 50 -Wait     # live server log
  node dist\index.js auth clients                          # who is connected
"@ | Write-Host
