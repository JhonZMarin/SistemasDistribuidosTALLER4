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

# url nuevo cordinador
$env:PUBLIC_WS_URL = "wss://breadless-keren-topfull.ngrok-free.dev"
$env:PEER_WS_URL = "wss://breadless-keren-topfull.ngrok-free.dev/peer"

Set-Location $PSScriptRoot
node index.js
