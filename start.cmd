@echo off
cd /d "%~dp0"

docker compose up --build -d
if errorlevel 1 exit /b %errorlevel%

docker compose ps
exit /b %errorlevel%
