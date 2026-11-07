@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Installing T-Lock (dsh-tlock) ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
