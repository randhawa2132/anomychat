$ErrorActionPreference = 'Stop'
$localDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $localDir '..\..')).Path
$baseCompose = Join-Path $localDir 'compose.yaml'
$mobileCompose = Join-Path $localDir 'mobile-compose.yaml'
$envFile = Join-Path $localDir '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Run infra/local/setup.ps1 first to create the local Synapse configuration.'
}

$network = Get-NetIPConfiguration | Where-Object {
    $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and
    (Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex).NetworkCategory -eq 'Private'
} | Select-Object -First 1
$lanIp = $network.IPv4Address.IPAddress
if (-not $lanIp) { throw 'No active private-network IPv4 address was found. Connect this PC and phone to the same private network.' }

$lanHost = ($lanIp -replace '\.', '-') + '.sslip.io'
$resolvedIp = Resolve-DnsName $lanHost -Type A -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress -First 1
if ($resolvedIp -ne $lanIp) { throw "$lanHost must resolve to $lanIp on this network before the phone test can work." }
$oldLanHost = $env:LAN_HOST
$oldMatrixUrl = $env:VITE_MATRIX_BASE_URL
try {
    $env:LAN_HOST = $lanHost
    $env:VITE_MATRIX_BASE_URL = "https://${lanHost}:8443"
    Push-Location $repoDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        docker compose -f $baseCompose -f $mobileCompose --env-file $envFile up -d
        if ($LASTEXITCODE -ne 0) { throw 'Local mobile stack failed to start.' }
    } finally {
        Pop-Location
    }

    $container = docker compose -f $baseCompose -f $mobileCompose --env-file $envFile ps -q caddy
    if ($LASTEXITCODE -ne 0 -or -not $container) { throw 'Caddy container was not found.' }
    $certPath = Join-Path $localDir 'data\mobile-test-ca.crt'
    docker cp "${container}:/data/caddy/pki/authorities/local/root.crt" $certPath
    if ($LASTEXITCODE -ne 0) { throw 'Caddy root certificate was not ready; retry this script after a few seconds.' }

    Write-Host "Local phone URL: https://${lanHost}:8443/"
    Write-Host "Matrix API: https://${lanHost}:8443/_matrix/client/versions"
    Write-Host "Android trust certificate: $certPath"
    Write-Host 'Install that certificate as a CA certificate on your Android phone before signing in.'
    Write-Host 'Only use this on your private Wi-Fi. Windows Firewall must allow TCP 8443 from the local subnet.'
} finally {
    $env:LAN_HOST = $oldLanHost
    $env:VITE_MATRIX_BASE_URL = $oldMatrixUrl
}
