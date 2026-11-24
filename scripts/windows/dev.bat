@echo off
rem Double-click: opens a terminal and runs the gateway in development mode (hot reload), this PC only.
start "Mock API Gateway (dev)" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Dev %*
