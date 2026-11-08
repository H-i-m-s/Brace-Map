@echo off
chcp 65001 >nul
setlocal

rem Brace Map release -- double-click to run
rem Uses pwsh 7 if available, otherwise falls back to Windows PowerShell

cd /d "%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
) else (
  echo [note] pwsh not found, falling back to Windows PowerShell
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
)

set RC=%errorlevel%
echo.
if not "%RC%"=="0" (
  echo [FAILED] exit code %RC%
) else (
  echo [DONE]
)
echo.
pause
exit /b %RC%
