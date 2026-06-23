# Start all services for local development (without Docker)
# Prerequisites: Docker running for PostgreSQL + Redis
# Usage: .\start-dev.ps1

$root = $PSScriptRoot

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
  cd '$root\backend';
  .\.venv\Scripts\Activate.ps1;
  uvicorn app.main:app --port 8000 --reload
"

Write-Host "Starting Celery Worker..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "
  cd '$root\backend';
  .\.venv\Scripts\Activate.ps1;
  celery -A app.celery_app worker --loglevel=info --concurrency=4
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
Write-Host "  Student App:       http://localhost:5173/?window=<id>" -ForegroundColor White
Write-Host "  Teacher Dashboard: http://localhost:5174" -ForegroundColor White
Write-Host "  Backend API docs:  http://localhost:8000/docs" -ForegroundColor White
Write-Host "  AI Worker docs:    http://localhost:8001/docs" -ForegroundColor White
