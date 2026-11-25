#Requires -Version 5.1
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ''
Write-Host '  ReproLens - Research Workspace' -ForegroundColor White
Write-Host '  Paper reproduction and verification agent' -ForegroundColor DarkGray
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[ReproLens] Node.js not found. Install Node.js 22+ from https://nodejs.org/' -ForegroundColor Red
  exit 1
}
Write-Host ("[ReproLens] Node.js " + (node --version)) -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '[ReproLens] Installing dependencies for the first run...' -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
if (-not (Test-Path (Join-Path $root '.env'))) {
  Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
  Write-Host '[ReproLens] Created .env. Configure the model in the web console.' -ForegroundColor Yellow
}

$addr = $env:REPROLENS_ADDR
if (-not $addr -and (Test-Path (Join-Path $root '.env'))) {
  $line = Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^\s*REPROLENS_ADDR\s*=' } | Select-Object -Last 1
  if ($line) { $addr = ($line -split '=', 2)[1].Trim() }
}
if (-not $addr) { $addr = '127.0.0.1:8080' }
$env:REPROLENS_ADDR = $addr
$url = "http://$addr"

Write-Host ("[ReproLens] URL: " + $url) -ForegroundColor Green
Write-Host '[ReproLens] Press Ctrl+C to stop the service' -ForegroundColor DarkGray
Write-Host ''

$job = Start-Job -ScriptBlock { param($dir) Set-Location $dir; npm run serve } -ArgumentList $root
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "$url/healthz" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if ($ready -and -not $NoBrowser) { cmd /c start "" $url }
  Receive-Job -Job $job -Wait -AutoRemoveJob
} finally {
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}