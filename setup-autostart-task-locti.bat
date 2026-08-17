@echo off
:: Registra/actualiza la tarea JarvisLocti para que arranque con Windows (sin login).
:: Pide UAC (admin) automaticamente al correrlo.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "setup-autostart-task-locti.ps1"
