@echo off
setlocal

echo ============================================================
echo   Attendance System - Starting All Services
echo ============================================================
echo.

:: Check Docker is running
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Please start Docker Desktop and try again.
    pause
    exit /b 1
)

:: Start all backend services
echo [1/3] Starting backend services (Docker)...
docker compose up -d
if errorlevel 1 (
    echo [ERROR] Failed to start Docker containers. See error above.
    pause
    exit /b 1
)
echo       Done. Backend running on http://localhost:8000
echo.

:: Student App
echo [2/3] Starting Student App (port 5173)...
if not exist "frontend\student-app\node_modules" (
    echo       Installing npm dependencies (first run only)...
    cd frontend\student-app
    npm install
    cd ..\..
)
start "Student App" cmd /k "cd /d %~dp0frontend\student-app && npm run dev"

:: Teacher Dashboard
echo [3/3] Starting Teacher Dashboard (port 5174)...
if not exist "frontend\teacher-dashboard\node_modules" (
    echo       Installing npm dependencies (first run only)...
    cd frontend\teacher-dashboard
    npm install
    cd ..\..
)
start "Teacher Dashboard" cmd /k "cd /d %~dp0frontend\teacher-dashboard && npm run dev"

echo.
echo ============================================================
echo   All services started!
echo.
echo   Teacher Dashboard : http://localhost:5174
echo   API Docs          : http://localhost:8000/docs
echo   Student App       : https://localhost:5173  (needs HTTPS)
echo ============================================================
echo.
echo Close the opened terminal windows to stop the frontend apps.
echo To stop Docker services: docker compose down
echo.
pause
