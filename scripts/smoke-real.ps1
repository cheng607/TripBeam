param(
  [string]$ApiBase = $(if ($env:VITE_API_BASE_URL) { $env:VITE_API_BASE_URL } else { 'http://127.0.0.1:3101' }),
  [string]$Location = '上海人民广场'
)

$ErrorActionPreference = 'Stop'
$ApiBase = $ApiBase.TrimEnd('/')

function Invoke-JsonPost([string]$Uri, $Body, [hashtable]$Headers = @{}) {
  return Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12)
}

Write-Host "[1/4] GET $ApiBase/health"
$health = Invoke-RestMethod -Method Get -Uri "$ApiBase/health"
if ($health.mapMode -ne 'amap') { throw "Real map check failed: mapMode=$($health.mapMode). DemoMapProvider is not allowed for release validation." }
if ($health.storageMode -ne 'postgres') { throw "Database check failed: storageMode=$($health.storageMode). Configure DATABASE_URL and verify PostgreSQL." }

Write-Host "[2/4] GET $ApiBase/ready"
$ready = Invoke-RestMethod -Method Get -Uri "$ApiBase/ready"
if ($ready.status -ne 'ready') { throw "Service is not ready: $($ready | ConvertTo-Json -Compress)" }

Write-Host "[3/4] POST $ApiBase/v1/locations/resolve"
$resolved = Invoke-JsonPost "$ApiBase/v1/locations/resolve" @{ text = $Location }
if (-not $resolved.location -or $resolved.location.lat -eq $null -or $resolved.location.lng -eq $null) {
  throw "Real map geocoding failed: $($resolved | ConvertTo-Json -Compress)"
}

Write-Host "[4/4] POST $ApiBase/v1/sessions/:id/turns"
$session = Invoke-JsonPost "$ApiBase/v1/sessions" @{}
$turnBody = @{ turnId = [guid]::NewGuid().ToString(); text = "I am near $Location and have four hours this afternoon; prefer local food and normal walking." }
$turnHeaders = @{ 'x-session-token' = $session.sessionToken }
$turn = Invoke-JsonPost "$ApiBase/v1/sessions/$($session.sessionId)/turns" $turnBody $turnHeaders
if (-not $turn.itineraries -and $turn.status -notin @('needs_clarification','ready')) {
  throw "Real planning flow failed: $($turn | ConvertTo-Json -Compress)"
}

Write-Host 'Real API smoke test passed: PostgreSQL, AMap Web Service, and session planning are available.' -ForegroundColor Green
