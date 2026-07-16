@echo off
setlocal
cd /d "%~dp0"

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

:: Student App — install deps if missing, then launch in new window
echo [2/3] Starting Student App (port 5173)...
if not exist "%~dp0frontend\student-app\node_modules" (
    echo       Installing npm dependencies (first run only)...
    pushd "%~dp0frontend\student-app"
    npm install
    popd
)
powershell -Command "Start-Process powershell -ArgumentList '-NoExit','-Command','cd \"%~dp0frontend\student-app\"; npm run dev'"

:: Teacher Dashboard — install deps if missing, then launch in new window
echo [3/3] Starting Teacher Dashboard (port 5174)...
if not exist "%~dp0frontend\teacher-dashboard\node_modules" (
    echo       Installing npm dependencies (first run only)...
    pushd "%~dp0frontend\teacher-dashboard"
    npm install
    popd
)
powershell -Command "Start-Process powershell -ArgumentList '-NoExit','-Command','cd \"%~dp0frontend\teacher-dashboard\"; npm run dev'"

:: Wait a few seconds for dev servers to start, then open browsers
echo Waiting for dev servers to start...
timeout /t 5 /nobreak >nul
start "" "http://localhost:5174"
start "" "http://localhost:5173"

echo.
echo ============================================================
echo   All services started!
echo.
echo   Teacher Dashboard : http://localhost:5174
echo   API Docs          : http://localhost:8000/docs
echo   Student App       : https://localhost:5173  (needs HTTPS)
echo ============================================================
echo.
echo Close the opened PowerShell windows to stop the frontend apps.
echo To stop Docker services: docker compose down
echo.
pause
