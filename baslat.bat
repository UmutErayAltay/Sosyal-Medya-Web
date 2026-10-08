@echo off
cd /d "%~dp0"
start "sosyal-medya" cmd /k python run.py
timeout /t 3 /nobreak >nul
start http://127.0.0.1:5000
