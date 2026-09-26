$ErrorActionPreference = 'Stop'
$localDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $localDir 'data'
$configFile = Join-Path $dataDir 'homeserver.yaml'
$envFile = Join-Path $localDir '.env'

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$docker = if ($dockerCommand) { $dockerCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $docker)) { throw 'Docker is not available. Install and start Docker Desktop, then rerun this script.' }
& $docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is installed but its engine is not running.' }
if ((Test-Path -LiteralPath $configFile) -or (Test-Path -LiteralPath $envFile)) {
    throw 'Local configuration already exists. This script will not overwrite keys or the database password.'
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function New-Secret([int]$bytes = 48) {
    $buffer = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$dbPassword = New-Secret
$registrationSecret = New-Secret
$macaroonSecret = New-Secret
$formSecret = New-Secret

Write-Host 'Generating the Synapse signing key...'
& $docker run --rm --mount "type=bind,source=$dataDir,target=/data" -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no ghcr.io/element-hq/synapse:v1.161.0 generate
if ($LASTEXITCODE -ne 0) { throw 'Synapse configuration generation failed.' }

$signingKey = Get-ChildItem -LiteralPath $dataDir -Filter '*.signing.key' | Select-Object -First 1
if (-not $signingKey) { throw 'Synapse did not generate a signing key.' }

$yaml = @"
server_name: "localhost"
public_baseurl: "http://localhost:8008/"
pid_file: "/data/homeserver.pid"
signing_key_path: "/data/$($signingKey.Name)"
media_store_path: "/data/media_store"
report_stats: false
enable_registration: false
registration_shared_secret: "$registrationSecret"
macaroon_secret_key: "$macaroonSecret"
form_secret: "$formSecret"
trusted_key_servers: []
federation_domain_whitelist: []
listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
rc_login:
  address:
    per_second: 0.2
    burst_count: 20
  account:
    per_second: 0.2
    burst_count: 20
database:
  name: psycopg2
  args:
    user: synapse
    password: "$dbPassword"
    database: synapse
    host: postgres
    port: 5432
    cp_min: 5
    cp_max: 10
"@

Set-Content -LiteralPath $configFile -Value $yaml -Encoding utf8
Set-Content -LiteralPath $envFile -Value "POSTGRES_PASSWORD=$dbPassword" -Encoding utf8
Write-Host 'Local configuration created. Run: docker compose -f infra/local/compose.yaml --env-file infra/local/.env up -d'
