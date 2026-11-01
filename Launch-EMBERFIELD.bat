@echo off
setlocal
title EMBERFIELD Launcher
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 goto try_python
py -3 -c "import sys; sys.exit(not (sys.version_info[0] == 3 and sys.version_info[1] in range(7, 100)))" >nul 2>&1
if errorlevel 1 goto try_python
py -3 "%~dp0scripts\launcher.py" %*
goto finished

:try_python
where python >nul 2>nul
if errorlevel 1 goto try_python3
python -c "import sys; sys.exit(not (sys.version_info[0] == 3 and sys.version_info[1] in range(7, 100)))" >nul 2>&1
if errorlevel 1 goto try_python3
python "%~dp0scripts\launcher.py" %*
goto finished

:try_python3
where python3 >nul 2>nul
if errorlevel 1 goto missing_python
python3 -c "import sys; sys.exit(not (sys.version_info[0] == 3 and sys.version_info[1] in range(7, 100)))" >nul 2>&1
if errorlevel 1 goto missing_python
python3 "%~dp0scripts\launcher.py" %*
goto finished

:missing_python
echo EMBERFIELD needs Python 3.7 or newer to launch.
echo Install Python 3 from https://www.python.org/downloads/ and try again.
pause
exit /b 1

:finished
if not errorlevel 1 exit /b 0
echo.
echo EMBERFIELD could not start. See the message above.
pause
exit /b 1
