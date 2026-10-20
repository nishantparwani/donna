@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
title Donna (keep this window open; close it to stop)
node server.js --open
pause
