@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "JAVA_EXE=%SCRIPT_DIR%..\jre\bin\java.exe"
if not exist "%JAVA_EXE%" (
  echo Embedded Java runtime not found: %JAVA_EXE%
  exit /b 1
)
"%JAVA_EXE%" -jar "%SCRIPT_DIR%apktool.jar" %*
