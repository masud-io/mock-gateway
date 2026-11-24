@echo off
rem Double-click: opens a terminal and runs the gateway on this PC only (http://127.0.0.1:3000).
start "Mock API Gateway" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
