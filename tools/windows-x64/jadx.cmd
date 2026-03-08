@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "JAVA_HOME=%SCRIPT_DIR%jre"
set "PATH=%JAVA_HOME%\bin;%PATH%"
call "%SCRIPT_DIR%jadx\bin\jadx.bat" %*
