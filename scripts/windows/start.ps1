# Starts the Mock API Gateway on this PC.
#   .\scripts\windows\start.ps1                 this PC only        (http://127.0.0.1:3000)
#   .\scripts\windows\start.ps1 -Share          reachable by others on your network (needs an admin account first)
#   .\scripts\windows\start.ps1 -Dev            development mode with hot reload (local only is best)
#   -SkipBuild  reuse the last build        -Port 3000  change the port
# Prefer the .cmd launchers next to this file: they open a terminal window for you.
param([switch]$Share, [switch]$Dev, [switch]$SkipBuild, [int]$Port = 3000)

$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
$bindHost = if ($Share) { "0.0.0.0" } else { "127.0.0.1" }

function Fail($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js is not installed. Install Node 20 or newer from https://nodejs.org" }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Fail "Node 20 or newer is required (found $(node -v))." }

# The embedded database allows one process at a time, and a second server would also fight over the build folder.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)").CommandLine
  Fail "Port $Port is already in use by process $($busy.OwningProcess):`n  $cmdline`nStop it first (Ctrl+C in its window, or: Stop-Process -Id $($busy.OwningProcess)), then run this again."
}

if (-not (Test-Path node_modules)) { Write-Host "Installing dependencies..."; npm install; if ($LASTEXITCODE) { Fail "npm install failed" } }
if (-not (Test-Path .data\pg)) { Write-Host "Creating the database..."; npm run db:migrate; if ($LASTEXITCODE) { Fail "Database setup failed" } }

if ($Share) {
  # Never expose the admin UI on the network before a login exists.
  cmd /c "npm run --silent admin -- status >nul 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Fail ("Refusing to share: no admin account exists yet.`n" +
      "Create one first:  npm run admin -- create you@example.com `"Your Name`"`n" +
      "(or start without -Share, open http://localhost:$Port/login, create it there, then restart with -Share).")
  }
  if (-not (Get-NetFirewallRule -DisplayName "Mock API Gateway" -ErrorAction SilentlyContinue)) {
    Write-Host "Note: Windows Firewall may block other computers. Run once, as Administrator:" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1 -Port $Port" -ForegroundColor Yellow
  }
  Write-Host "Team URLs (same network):" -ForegroundColor Green
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$Port   ($($_.InterfaceAlias))" -ForegroundColor Green }
  if ($Dev) { Write-Host "Note: dev mode blocks hot-reload requests from other addresses. Prefer the non-dev launcher for team use." -ForegroundColor Yellow }
}

if ($Dev) {
  Write-Host "Starting in development mode on http://127.0.0.1:$Port ..."
  npx next dev -H $bindHost -p $Port
} else {
  if (-not $SkipBuild) { npm run build; if ($LASTEXITCODE) { Fail "Build failed" } }
  Write-Host "Starting on http://127.0.0.1:$Port (Ctrl+C to stop) ..." -ForegroundColor Green
  npx next start -H $bindHost -p $Port
}
