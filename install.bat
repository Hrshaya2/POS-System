@echo off
title Nangi POS - Setup
setlocal

REM ============================================================
REM  Nangi POS - One-Click Installer Launcher
REM  This script self-elevates to Administrator and runs install.ps1
REM ============================================================

REM --- Check if we are already running as Administrator ---
net session >nul 2>&1
if %errorlevel% equ 0 (
    goto :run_script
)

REM --- Not admin - relaunch elevated ---
echo Requesting Administrator privileges...
echo.

REM Get the full path to this batch file
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_NAME=%~nx0"

REM Relaunch as Administrator using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"\"%SCRIPT_DIR%%SCRIPT_NAME%\"\"' -Verb RunAs -WorkingDirectory '%SCRIPT_DIR%'"

exit /b

:run_script
REM --- We are admin - run the PowerShell installer ---
echo.
echo ============================================
echo   Nangi POS - Automated Setup
echo ============================================
echo.

REM Run the main PowerShell script
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo Setup script finished.
pause