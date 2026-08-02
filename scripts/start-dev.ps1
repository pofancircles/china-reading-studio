param(
  [int]$FrontendPort = 3000,
  [int]$BackendPort = 8000
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $projectRoot ".venv"
$python = Join-Path $venvRoot "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
  $bootstrapPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  if (-not (Test-Path -LiteralPath $bootstrapPython)) {
    $bootstrapPython = (Get-Command python -ErrorAction SilentlyContinue).Source
  }
  if (-not $bootstrapPython) {
    throw "Python was not found. Install Python or update scripts/start-dev.ps1."
  }
  Write-Host "Creating the project Python environment (first run only) ..." -ForegroundColor Yellow
  & $bootstrapPython -m venv $venvRoot
  & $python -m pip install --disable-pip-version-check -r (Join-Path $projectRoot "backend\requirements.txt")
}

Write-Host "Starting backend at http://127.0.0.1:$BackendPort ..." -ForegroundColor Green
Start-Process -FilePath $python -ArgumentList "-m", "uvicorn", "main:app", "--reload", "--host", "127.0.0.1", "--port", $BackendPort -WorkingDirectory (Join-Path $projectRoot "backend") -WindowStyle Hidden | Out-Null

Write-Host "Starting frontend at http://localhost:$FrontendPort ..." -ForegroundColor Green
Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev", "--", "--host", "127.0.0.1", "--port", $FrontendPort -WorkingDirectory (Join-Path $projectRoot "frontend") -WindowStyle Hidden | Out-Null

Write-Host "Open http://localhost:$FrontendPort" -ForegroundColor Cyan
Write-Host "The local services are running in the background." -ForegroundColor DarkGray
