@echo off
:: Reinicio robusto de Jarvis (agregado 2026-08-25): prueba PM2 primero,
:: y si el daemon de PM2 esta colgado (visto ese dia: 5 procesos zombis,
:: EPERM en el pipe RPC), se autolimpia y arranca server+tunnel directo
:: para no dejarte sin Jarvis. No pide admin. Detalle: restart-jarvis-full.ps1
::
:: Si esto igual no lo levanta, el problema es mas grave (proceso trabado
:: en Session 0/integridad alta) y hace falta "Reiniciar Jarvis (Admin).bat"
:: del escritorio, que si pide UAC.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-jarvis-full.ps1"
echo.
echo Log completo en %TEMP%\jarvis-full-restart.log
pause
