# Lets other computers on your network reach the gateway through Windows Firewall.
# Run once, from a PowerShell opened as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1 [-Port 3000] [-Remove]
# The rule applies to Private and Domain networks only (not Public Wi-Fi).
param([int]$Port = 3000, [switch]$Remove)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Run this from a PowerShell opened as Administrator." -ForegroundColor Red; exit 1 }

Remove-NetFirewallRule -DisplayName "Mock API Gateway" -ErrorAction SilentlyContinue
if ($Remove) { Write-Host "Firewall rule removed."; exit 0 }

New-NetFirewallRule -DisplayName "Mock API Gateway" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain | Out-Null
Write-Host "Allowed inbound TCP $Port on Private/Domain networks." -ForegroundColor Green
Get-NetConnectionProfile | ForEach-Object { Write-Host "  network '$($_.Name)' is $($_.NetworkCategory)" }
Write-Host "If your network is listed as Public, switch it to Private in Settings > Network, or the rule won't apply."
