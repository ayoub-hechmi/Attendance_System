#Requires -Version 5.1
# AI Face Recognition Attendance System — Setup Wizard
# Run from the project root: powershell -ExecutionPolicy Bypass -File .\setup.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step { param($n, $m) Write-Host ("`n[$n/9] $m") -ForegroundColor Cyan }
function OK   { param($m)    Write-Host ("    [OK]  $m") -ForegroundColor Green }
function Info { param($m)    Write-Host ("    ...   $m") -ForegroundColor DarkGray }
function Warn { param($m)    Write-Host ("    [!!]  $m") -ForegroundColor Yellow }
function Fail { param($m)    Write-Host ("    [ERR] $m") -ForegroundColor Red; exit 1 }

function Install-App {
    param($id, $name, $cmd)
    Info "Installing $name via winget..."
    winget install --id $id --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
    Refresh-Path
    # If the tool is now in PATH, the install succeeded regardless of winget exit code
    if ($cmd -and (Get-Command $cmd -ErrorAction SilentlyContinue)) { return }
    # -1978335189 = APPINSTALLER_ERROR_ALREADY_INSTALLED — treat as success
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        Fail "Failed to install $name (exit $LASTEXITCODE). Install it manually and re-run."
    }
    OK "$name installed"
}

function Refresh-Path {
    $m = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $u = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$m;$u"
}

# ── Header ────────────────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  +----------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |  AI Attendance System - Setup Wizard        |" -ForegroundColor Cyan
Write-Host "  +----------------------------------------------+" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Installs all prerequisites and configures everything from scratch." -ForegroundColor DarkGray
Write-Host "  First run takes 10-15 min (Docker images + AI model download ~500 MB)." -ForegroundColor DarkGray
Write-Host ""
Read-Host "  Press Enter to begin"

# ── [1/9] winget ──────────────────────────────────────────────────────────────
Step 1 "Package manager (winget)"
$wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
if (-not $wingetCmd) {
    Warn "winget not found. Opening Microsoft Store to install App Installer..."
    Start-Process "ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1"
    Fail "Install 'App Installer' from the Store window, then re-run this script."
}
OK "winget found"

# ── [2/9] Git ─────────────────────────────────────────────────────────────────
Step 2 "Git"
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Install-App "Git.Git" "Git" "git"
    Refresh-Path
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Fail "Git installed but not in PATH yet. Open a new PowerShell window and re-run."
    }
}
OK "$(git --version)"

# ── [3/9] Node.js ─────────────────────────────────────────────────────────────
Step 3 "Node.js (18+)"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$needNode = $true
if ($nodeCmd) {
    $nodeVerStr = (node --version).Trim()
    $nodeMajor  = [int]($nodeVerStr -replace 'v(\d+)\..*', '$1')
    if ($nodeMajor -ge 18) {
        OK "Node.js $nodeVerStr"
        $needNode = $false
    } else {
        Warn "Node.js $nodeVerStr is too old (need v18+). Will upgrade."
    }
}
if ($needNode) {
    Install-App "OpenJS.NodeJS.LTS" "Node.js LTS" "node"
    Refresh-Path
    OK "Node.js $((node --version).Trim())"
}

# ── [4/9] Docker Desktop ──────────────────────────────────────────────────────
Step 4 "Docker Desktop"
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Warn "Docker Desktop not found. Installing (~500 MB download)..."
    Install-App "Docker.DockerDesktop" "Docker Desktop" "docker"
    Write-Host ""
    Warn "Docker Desktop installed. A system restart is required."
    Warn "After restarting: open Docker Desktop, wait for it to load, then re-run this script."
    $r = Read-Host "  Restart now? (y/n)"
    if ($r -eq 'y') { Restart-Computer -Force }
    exit 0
}

# Docker installed — check daemon is running
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Warn "Docker is installed but not running."
    Write-Host "  1. Open Docker Desktop from the Start menu." -ForegroundColor Yellow
    Write-Host "  2. Wait for the whale icon in the taskbar to stop animating." -ForegroundColor Yellow
    Read-Host "  3. Press Enter when Docker is ready"
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Docker still not running. Start it and re-run." }
}
OK "$(docker --version)"

# ── [5/9] mkcert ──────────────────────────────────────────────────────────────
Step 5 "mkcert"
$mkcertCmd = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcertCmd) {
    Install-App "FiloSottile.mkcert" "mkcert" "mkcert"
    Refresh-Path
    $mkcertCmd = Get-Command mkcert -ErrorAction SilentlyContinue
    if (-not $mkcertCmd) {
        Fail "mkcert installed but not in PATH. Open a new PowerShell window and re-run."
    }
}
OK "mkcert $((mkcert --version 2>&1).Trim())"

# ── [6/9] Configuration ───────────────────────────────────────────────────────
Step 6 "Configuration"

# Auto-detect local IP
$ipInfo = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual') -and
        $_.IPAddress -notlike '169.*' -and
        $_.IPAddress -ne '127.0.0.1'
    } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1

$LocalIp = ""
Write-Host ""
if ($ipInfo -and $ipInfo.IPAddress) {
    $detected = $ipInfo.IPAddress
    Write-Host "  Detected local IP: $detected" -ForegroundColor Cyan
    $ans = Read-Host "  Use this IP for the student QR link? (y/n)"
    if ($ans -eq 'y') { $LocalIp = $detected }
}
if (-not $LocalIp) {
    Warn "Run 'ipconfig' in another window and look for your Wi-Fi 'IPv4 Address'."
    $LocalIp = Read-Host "  Enter your local IP address (e.g. 192.168.1.10)"
}
if ($LocalIp -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    Fail "Invalid IP address: $LocalIp"
}

Write-Host ""
$DbPass = ""
while ($DbPass.Length -lt 8) {
    $DbPass = Read-Host "  Choose a database password (min 8 chars)"
    if ($DbPass.Length -lt 8) { Warn "Too short. Try again." }
}

# 64-char hex secret key
$SecretKey = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

OK "IP: $LocalIp | Password: set | Secret key: generated"

# ── [7/9] .env + directories ──────────────────────────────────────────────────
Step 7 "Creating .env and directories"
Set-Location $ProjectRoot

$envLines = @(
    "POSTGRES_USER=attendance_user",
    "POSTGRES_PASSWORD=$DbPass",
    "SECRET_KEY=$SecretKey"
)
# Write UTF-8 without BOM (Docker Compose requirement)
[System.IO.File]::WriteAllLines(
    (Join-Path $ProjectRoot ".env"),
    $envLines,
    [System.Text.UTF8Encoding]::new($false)
)
OK ".env written"

if (-not (Test-Path "face_vectors_backup")) {
    New-Item -ItemType Directory "face_vectors_backup" | Out-Null
}
OK "face_vectors_backup/ directory ready"

# ── [8/9] HTTPS certificate ───────────────────────────────────────────────────
Step 8 "HTTPS certificate"
Info "Installing local Certificate Authority (a UAC prompt may appear)..."
mkcert -install
if ($LASTEXITCODE -ne 0) { Fail "mkcert -install failed." }
OK "CA installed in system trust store"

$CertDir = Join-Path $ProjectRoot "frontend\student-app"
Set-Location $CertDir

Info "Generating certificate for: localhost  127.0.0.1  $LocalIp ..."
mkcert localhost 127.0.0.1 $LocalIp
if ($LASTEXITCODE -ne 0) { Fail "mkcert certificate generation failed." }

# Rename to the filenames Vite expects
$keyPem  = Get-ChildItem -Filter "*-key.pem"  -ErrorAction SilentlyContinue | Select-Object -First 1
$certPem = Get-ChildItem -Filter "*.pem" -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -notlike "*-key.pem" } |
           Select-Object -First 1

if ($keyPem  -and $keyPem.Name  -ne "key.pem")  { Rename-Item $keyPem.FullName  "key.pem"  -Force }
if ($certPem -and $certPem.Name -ne "cert.pem") { Rename-Item $certPem.FullName "cert.pem" -Force }

if (-not (Test-Path "key.pem") -or -not (Test-Path "cert.pem")) {
    Fail "Certificate files not found after generation. Check mkcert output."
}
OK "key.pem and cert.pem ready"
Set-Location $ProjectRoot

# ── [9/9] npm install + Docker Compose ───────────────────────────────────────
Step 9 "npm install + Docker Compose"

Info "Installing student app dependencies..."
Set-Location (Join-Path $ProjectRoot "frontend\student-app")
npm install --silent
if ($LASTEXITCODE -ne 0) { Fail "npm install failed for student-app." }
OK "Student app ready"

Info "Installing teacher dashboard dependencies..."
Set-Location (Join-Path $ProjectRoot "frontend\teacher-dashboard")
npm install --silent
if ($LASTEXITCODE -ne 0) { Fail "npm install failed for teacher-dashboard." }
OK "Teacher dashboard ready"

Set-Location $ProjectRoot
Write-Host ""
Warn "Building Docker images and downloading AI models. This takes 10-15 min on first run."
Warn "Do not close this window."
Write-Host ""
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail "docker compose up --build failed." }
OK "All Docker services started"

# Wait for backend API to respond
Info "Waiting for backend API to be ready..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 5
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8000/docs" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($r -and $r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Info "Still waiting... ($i/30)"
}
if ($ready) {
    OK "Backend API is up (http://localhost:8000/docs)"
} else {
    Warn "Backend is taking longer than expected. The AI worker is still downloading model weights."
    Warn "Run: docker compose logs -f ai-worker   to monitor progress."
}

# ── Startup convenience scripts ───────────────────────────────────────────────
$startContent = "@echo off`r`ncd /d ""%~dp0""`r`n" +
"echo Starting backend services...`r`n" +
"docker compose up -d`r`n" +
"echo.`r`n" +
"echo Starting student app...`r`n" +
"start ""Student App"" cmd /k ""cd /d """"%~dp0frontend\student-app"""" && npm run dev""`r`n" +
"timeout /t 3 /nobreak > nul`r`n" +
"echo Starting teacher dashboard...`r`n" +
"start ""Teacher Dashboard"" cmd /k ""cd /d """"%~dp0frontend\teacher-dashboard"""" && npm run dev""`r`n" +
"echo.`r`n" +
"echo ================================================================`r`n" +
"echo   Student App       ^>  https://${LocalIp}:5173`r`n" +
"echo   Teacher Dashboard ^>  http://localhost:5174`r`n" +
"echo   API Docs          ^>  http://localhost:8000/docs`r`n" +
"echo ================================================================`r`n" +
"echo.`r`n" +
"pause`r`n"

[System.IO.File]::WriteAllText(
    (Join-Path $ProjectRoot "start.bat"),
    $startContent,
    [System.Text.ASCIIEncoding]::new()
)

$stopContent = "@echo off`r`ncd /d ""%~dp0""`r`necho Stopping all services...`r`ndocker compose down`r`necho Done.`r`npause`r`n"
[System.IO.File]::WriteAllText(
    (Join-Path $ProjectRoot "stop.bat"),
    $stopContent,
    [System.Text.ASCIIEncoding]::new()
)
OK "start.bat and stop.bat created"

# ── Summary ───────────────────────────────────────────────────────────────────
$caRoot = (mkcert -CAROOT 2>&1).Trim()

Write-Host ""
Write-Host "  +--------------------------------------------------+" -ForegroundColor Green
Write-Host "  |   Setup complete!                               |" -ForegroundColor Green
Write-Host "  +--------------------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "  START EVERY DAY" -ForegroundColor White
Write-Host "    Double-click: start.bat" -ForegroundColor Cyan
Write-Host ""
Write-Host "  URLs" -ForegroundColor White
Write-Host "    Student App       https://${LocalIp}:5173" -ForegroundColor Cyan
Write-Host "    Teacher Dashboard http://localhost:5174" -ForegroundColor Cyan
Write-Host "    API Docs          http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "  FIRST TIME — create a teacher account" -ForegroundColor White
Write-Host "    Open a new terminal and run:" -ForegroundColor DarkGray
Write-Host "    curl -s -X POST http://localhost:8000/api/v1/auth/register \`\`" -ForegroundColor DarkGray
Write-Host "      -H `"Content-Type: application/json`" \`\`" -ForegroundColor DarkGray
Write-Host "      -d '{`"name`":`"Prof Name`",`"email`":`"prof@uni.edu`",`"password`":`"yourpassword`"}'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  STUDENT PHONES — install the CA certificate (one time per phone)" -ForegroundColor White
Write-Host "    Share this file with students:" -ForegroundColor DarkGray
Write-Host "    $caRoot\rootCA.pem" -ForegroundColor Cyan
Write-Host "    Android: open file > Install certificate" -ForegroundColor DarkGray
Write-Host "    iOS: open file > Settings > General > VPN & Device Management > install" -ForegroundColor DarkGray
Write-Host "         then: Settings > General > About > Certificate Trust Settings > enable" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  STOP" -ForegroundColor White
Write-Host "    Double-click: stop.bat" -ForegroundColor Cyan
Write-Host ""
