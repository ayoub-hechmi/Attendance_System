# Start all services for local development
# Usage: .\start-dev.ps1

$root = $PSScriptRoot

# Detect host IP for QR code links.
# Prefer the Wi-Fi adapter; fall back to the first non-virtual IPv4.
$detectedIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
               Select-Object -First 1).IPAddress

if (-not $detectedIp) {
    $detectedIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.IPAddress -notmatch '^127\.' -and
        $_.IPAddress -notmatch '^169\.254\.' -and
        $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Docker|WSL|Bluetooth'
    } | Select-Object -First 1).IPAddress
}

if ($detectedIp) {
    Write-Host "  Detected IP: $detectedIp" -ForegroundColor Gray
    # Write to a file so the backend can read it without relying on env var inheritance
    $detectedIp | Out-File -FilePath "$root\backend\.host_ip" -Encoding ASCII -NoNewline
} else {
    Write-Host "  Could not detect host IP - QR code will use localhost" -ForegroundColor Yellow
}

Write-Host "Starting PostgreSQL + Redis via Docker..." -ForegroundColor Cyan
docker compose up db redis -d

Write-Host "Starting AI Worker..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  cd '$root\ai-worker';
  .\.venv\Scripts\Activate.ps1;
  uvicorn main:app --port 8001 --reload
"

Start-Sleep -Seconds 3

Write-Host "Starting FastAPI Backend..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  `$env:HOST_IP = '$detectedIp';
  cd '$root\backend';
  .\.venv\Scripts\Activate.ps1;
  uvicorn app.main:app --port 8000 --reload
"

Write-Host "Starting Celery Worker..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  cd '$root\backend';
  .\.venv\Scripts\Activate.ps1;
  celery -A app.celery_app worker --loglevel=info --pool=solo
"

Write-Host "Starting Student App (port 5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  cd '$root\frontend\student-app';
  npm run dev
"

Write-Host "Starting Teacher Dashboard (port 5174)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  cd '$root\frontend\teacher-dashboard';
  npm run dev
"

Write-Host ""
Write-Host "All services started!" -ForegroundColor Green
Write-Host "  Student App:       https://localhost:5173" -ForegroundColor White
Write-Host "  Teacher Dashboard: http://localhost:5174" -ForegroundColor White
Write-Host "  Backend API docs:  http://localhost:8000/docs" -ForegroundColor White
if ($detectedIp) {
    Write-Host "  QR codes will use: https://$($detectedIp):5173" -ForegroundColor White
}
