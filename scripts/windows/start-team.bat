@echo off
rem Double-click: opens a terminal and runs the gateway so others on your network can reach it.
rem Needs an admin account first (see README) and, once, scripts\windows\open-firewall.ps1 as Administrator.
start "Mock API Gateway (team)" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Share %*
