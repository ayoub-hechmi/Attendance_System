$root = $PSScriptRoot

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Attendance System - Starting All Services" -ForegroundColor Cyan
Write-Host "============================================================"
Write-Host ""

# Check Docker
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Docker is not running. Please start Docker Desktop and try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Start backend containers
Write-Host "[1/3] Starting backend services (Docker)..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to start Docker containers." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "      Done. Backend running on http://localhost:8000" -ForegroundColor Green
Write-Host ""

# Student App
Write-Host "[2/3] Starting Student App (port 5173)..." -ForegroundColor Cyan
if (-not (Test-Path "$root\frontend\student-app\node_modules")) {
    Write-Host "      Installing npm dependencies (first run only)..." -ForegroundColor Yellow
    Push-Location "$root\frontend\student-app"
    npm install
    Pop-Location
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend\student-app'; npm run dev"

# Teacher Dashboard
Write-Host "[3/3] Starting Teacher Dashboard (port 5174)..." -ForegroundColor Cyan
if (-not (Test-Path "$root\frontend\teacher-dashboard\node_modules")) {
    Write-Host "      Installing npm dependencies (first run only)..." -ForegroundColor Yellow
    Push-Location "$root\frontend\teacher-dashboard"
    npm install
    Pop-Location
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend\teacher-dashboard'; npm run dev"

# Wait for Vite to start, then open browsers
Write-Host ""
Write-Host "Waiting for servers to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 6
Start-Process "http://localhost:5174"
Start-Process "https://localhost:5173"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  All services started!" -ForegroundColor Green
Write-Host ""
Write-Host "  Teacher Dashboard : http://localhost:5174"
Write-Host "  API Docs          : http://localhost:8000/docs"
Write-Host "  Student App       : https://localhost:5173"
Write-Host "============================================================"
Write-Host ""
Write-Host "Close the opened PowerShell windows to stop the frontend apps."
Write-Host "To stop Docker services run: docker compose down"
Write-Host ""
Read-Host "Press Enter to close this window"
