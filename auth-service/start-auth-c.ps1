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

# Sobrescrituras para el tercer auth.
$env:PORT = "4002"
$env:PEER_PORT = "5002"
$env:AUTH_ID = "auth-c"
$env:PUBLIC_URL = "http://localhost:4002"
$env:PEER_URL = "ws://localhost:5002"

Set-Location $PSScriptRoot
node --experimental-sqlite index.js
