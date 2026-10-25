@echo off
setlocal
rem Capstan launcher for approved Windows environments.
rem -ExecutionPolicy Bypass applies ONLY to this PowerShell process.
rem It does not change the machine policy, require admin rights,
rem or override Group Policy, AppLocker, WDAC, or enterprise controls.
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" (
  echo [Capstan] Windows PowerShell 5.1 was not found.
  pause
  exit /b 1
)
echo [Capstan] Starting the local-only video editor, process-scoped PowerShell policy.
echo [Capstan] Existing local applications and their ports will not be disturbed.
"%POWERSHELL%" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-Capstan.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo [Capstan] Startup failed ^(exit code %RESULT%^).
  echo [Capstan] Check the error above. Organization policy may restrict scripts even with a process-level switch.
  pause
)
exit /b %RESULT%