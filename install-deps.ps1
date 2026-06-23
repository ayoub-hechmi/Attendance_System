# Run this once after cloning to install all Python dependencies
$root = $PSScriptRoot

Write-Host "Installing backend dependencies..." -ForegroundColor Cyan
& "$root\backend\.venv\Scripts\pip.exe" install -r "$root\backend\requirements.txt"

Write-Host "Installing AI worker dependencies (this may take a while — downloads YOLO + DeepFace)..." -ForegroundColor Cyan
& "$root\ai-worker\.venv\Scripts\pip.exe" install -r "$root\ai-worker\requirements.txt"

Write-Host "Done! Run .\start-dev.ps1 to start all services." -ForegroundColor Green
