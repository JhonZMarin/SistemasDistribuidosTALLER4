# ─────────────────────────────────────────────────────────────────────────
#  start-auth-3.ps1 — Levanta la tercera instancia del auth (réplica)
# ─────────────────────────────────────────────────────────────────────────

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

# Sobrescrituras para la tercera instancia (réplica)
$env:PORT = "4002"
$env:AUTH_NODE_ID = "auth-3"
$env:AUTH_ROLE = "replica"
$env:AUTH_PEERS = "ws://localhost:4500,ws://localhost:4501"
$env:AUTH_WS_PORT = "4502"
$env:AUTH_PUBLIC_URL = "http://localhost:4002"

Set-Location $PSScriptRoot
node --experimental-sqlite index.js
