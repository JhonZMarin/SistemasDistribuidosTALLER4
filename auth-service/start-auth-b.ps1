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

# Sobrescrituras para el segundo auth.
$env:PORT = "4001"
$env:PEER_PORT = "5001"
$env:AUTH_ID = "auth-b"
$env:PUBLIC_URL = "https://prevail-hardening-antitrust.ngrok-free.dev"
$env:PEER_URL = "ws://localhost:5001"

Set-Location $PSScriptRoot
node --experimental-sqlite index.js
