$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OcrDir = Join-Path $Root "ocr-service"
$VenvPython = Join-Path $OcrDir ".venv\Scripts\python.exe"
$Python = "python"

if (Test-Path -LiteralPath $VenvPython) {
  $Python = $VenvPython
}

$ServiceReady = $false
try {
  $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/health" -TimeoutSec 1
  $ServiceReady = $Response.StatusCode -eq 200
} catch {
  $ServiceReady = $false
}

if (-not $ServiceReady) {
  Start-Process -FilePath $Python -ArgumentList @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8765") -WorkingDirectory $OcrDir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Start-Process -FilePath (Join-Path $Root "index.html")
