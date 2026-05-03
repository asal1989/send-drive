@echo off
echo Connecting to SendDrive server...

set SERVER_IP=192.168.1.06
set SERVER_USER=Administrator

ssh %SERVER_USER%@%SERVER_IP% "Start-Process powershell -ArgumentList '-NoExit','-Command','cd ''H:\OFFICE PROJECTS\senddrive\server''; node index.js'"

ssh %SERVER_USER%@%SERVER_IP% "Start-Process powershell -ArgumentList '-NoExit','-Command','cd ''H:\OFFICE PROJECTS\senddrive\senddrive''; npm run dev -- --host'"

echo.
echo SendDrive servers started on %SERVER_IP%
echo Frontend : http://%SERVER_IP%:5173
echo Backend  : http://%SERVER_IP%:3001
echo.
pause
