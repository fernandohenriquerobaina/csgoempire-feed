@echo off
setlocal
cd /d %~dp0
if not exist collector\node_modules (
  cd collector
  call npm install
  call npx playwright install chromium
  cd ..
)
if not exist publish mkdir publish
node collector\index.js --headless --hours=6 --out=publish\latest-6h.json
if errorlevel 1 exit /b 1
echo.
echo OK: publish\latest-6h.json
echo.
pause
