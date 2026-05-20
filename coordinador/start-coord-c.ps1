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

# Sobrescrituras para el tercer coordinador.
$env:PORT = "5002"
$env:PEER_PORT = "5102"
$env:COORDINATOR_ID = "coord-c"

# Reemplaza esta URL por el tercer ngrok antes de la demo publica.
$env:PUBLIC_WS_URL = "ws://localhost:5002"
$env:PEER_WS_URL = "ws://localhost:5102"

Set-Location $PSScriptRoot
node index.js
