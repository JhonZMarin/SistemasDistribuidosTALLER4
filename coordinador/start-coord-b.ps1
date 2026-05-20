$baseEnvPath = Join-Path $PSScriptRoot ".env"

if (-not (Test-Path -LiteralPath $baseEnvPath)) {
    Write-Error "No existe el archivo base $baseEnvPath"
    exit 1
}

Get-Content -LiteralPath $baseEnvPath | ForEach-Object {
    $line = $_.Trim()

    if (-not $line -or $line.StartsWith("#")) {
        return
    }

    $parts = $line -split "=", 2

    if ($parts.Count -ne 2) {
        return
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()

    [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

# Sobrescrituras para el segundo coordinador.
$env:PORT = "5001"
$env:PEER_PORT = "5101"
$env:COORDINATOR_ID = "coord-b"
$env:PUBLIC_WS_URL = "wss://darcy-finger-squelchingly.ngrok-free.dev"
$env:PEER_WS_URL = "ws://localhost:5101"

Set-Location $PSScriptRoot
node index.js
