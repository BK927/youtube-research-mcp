[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "youtube-mcp-aio",
  [string]$RepositoryName = "mcp",
  [string]$ImageName = "youtube-mcp-aio",
  [string]$RuntimeServiceAccountName = "youtube-mcp-runner",
  [string]$OAuthCodeCollection = "youtube_oauth_codes",
  [string[]]$SmokeVideoIds = @("dQw4w9WgXcQ", "arj7oStGLkU", "iG9CE55wbtY"),
  [string]$PotProviderImage = "docker.io/brainicism/bgutil-ytdlp-pot-provider@sha256:1aaa43a0ca72dfca6a6d2129a0fb4a23465c25adb1b043f8aff829a20825646b",
  [string]$TokenEnvironmentVariable = "YOUTUBE_MCP_ACCESS_TOKEN",
  [switch]$RotateAccessToken,
  [switch]$Promote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) { throw "gcloud command failed: gcloud $($Arguments -join ' ')" }
}

function Test-GcloudResource {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments *> $null
  return $LASTEXITCODE -eq 0
}

function New-RandomHex {
  param([int]$ByteCount = 32)
  $bytes = [byte[]]::new($ByteCount)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Get-LatestSecretVersion {
  param([string]$Name)
  $raw = @(& gcloud secrets versions list $Name --project $ProjectId --filter "state=ENABLED" --sort-by "~createTime" --limit 1 --format "value(name)") -join ""
  $raw = $raw.Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not list versions for '$Name'. Run provision-gcp.ps1 first." }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "Secret '$Name' has no enabled numeric version." }
  return ($raw -split "/")[-1]
}

function Add-SecretVersion {
  param([string]$Name, [string]$Value)
  $path = Join-Path ([IO.Path]::GetTempPath()) ("youtube-mcp-secret-{0}" -f [Guid]::NewGuid().ToString("N"))
  try {
    [IO.File]::WriteAllText($path, $Value, [Text.UTF8Encoding]::new($false))
    & gcloud secrets versions add $Name --project $ProjectId --data-file=$path --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not rotate '$Name'." }
  }
  finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Get-ServiceDocument {
  $json = & gcloud run services describe $ServiceName --project $ProjectId --region $Region --format json
  if ($LASTEXITCODE -ne 0) { throw "Cloud Run service '$ServiceName' could not be described." }
  return ($json | ConvertFrom-Json)
}

function Get-TaggedUrl {
  param([object]$Document, [string]$Tag)
  $entries = @()
  if ($Document.status.PSObject.Properties.Name -contains "traffic") { $entries += @($Document.status.traffic) }
  if ($Document.status.PSObject.Properties.Name -contains "trafficStatuses") { $entries += @($Document.status.trafficStatuses) }
  $match = @($entries | Where-Object {
      $_.PSObject.Properties["tag"] -and $_.tag -eq $Tag -and
      $_.PSObject.Properties["url"] -and $_.url
    } | Select-Object -First 1)
  if ($match.Count -eq 0) { return $null }
  return [string]$match[0].url
}

function Get-TaggedRevision {
  param([object]$Document, [string]$Tag)
  $entries = @()
  if ($Document.status.PSObject.Properties.Name -contains "traffic") { $entries += @($Document.status.traffic) }
  if ($Document.status.PSObject.Properties.Name -contains "trafficStatuses") { $entries += @($Document.status.trafficStatuses) }
  $match = @($entries | Where-Object {
      $_.PSObject.Properties["tag"] -and $_.tag -eq $Tag -and
      $_.PSObject.Properties["revisionName"] -and $_.revisionName
    } | Select-Object -First 1)
  if ($match.Count -eq 0) { return $null }
  return [string]$match[0].revisionName
}

function Get-StableRevision {
  param([object]$Document)
  $match = @($Document.status.traffic | Where-Object {
      $_.PSObject.Properties["revisionName"] -and
      $_.PSObject.Properties["percent"] -and
      [int]$_.percent -gt 0
    } | Sort-Object -Property percent -Descending | Select-Object -First 1)
  if ($match.Count -eq 0) { throw "The existing service has no stable revision receiving traffic." }
  return [string]$match[0].revisionName
}

function Get-RunApiHeaders {
  $token = (@(& gcloud auth print-access-token) -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) { throw "Could not obtain a Google Cloud access token." }
  return @{ Authorization = "Bearer $token" }
}

function Wait-RunOperation {
  param([object]$Operation, [hashtable]$Headers)
  $current = $Operation
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
  while (-not ($current.PSObject.Properties.Name -contains "done") -or -not [bool]$current.done) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Timed out waiting for the Cloud Run service update." }
    Start-Sleep -Seconds 2
    $current = Invoke-RestMethod -Uri "https://run.googleapis.com/v2/$($current.name)" -Headers $Headers
  }
  if ($current.PSObject.Properties.Name -contains "error") {
    throw "Cloud Run service update failed: $($current.error.message)"
  }
  return $current
}

function Invoke-RunServicePatch {
  param([object]$Body, [bool]$ValidateOnly)
  $headers = Get-RunApiHeaders
  $query = "updateMask=template,traffic,scaling,ingress&forceNewRevision=true&validateOnly=$($ValidateOnly.ToString().ToLowerInvariant())"
  $uri = "https://run.googleapis.com/v2/projects/$ProjectId/locations/$Region/services/$ServiceName`?$query"
  $json = $Body | ConvertTo-Json -Depth 30 -Compress
  $operation = Invoke-RestMethod -Uri $uri -Method Patch -Headers $headers -ContentType "application/json" -Body $json
  # validateOnly operations are ephemeral and cannot be polled through the
  # operations collection. A successful PATCH response is the validation result.
  if ($ValidateOnly) { return $operation }
  return Wait-RunOperation $operation $headers
}

function Deploy-Candidate {
  param([string]$RevisionSuffix, [string]$PublicBaseUrl, [string]$AllowedHosts, [string]$StableRevision)
  $environment = [ordered]@{
    MCP_TRANSPORT = "http"
    HOST = "0.0.0.0"
    MCP_PATH = "/mcp"
    HEALTH_PATH = "/health"
    HTTP_MAX_BODY_BYTES = "2097152"
    HTTP_REQUEST_TIMEOUT_MS = "300000"
    MCP_ALLOW_UNAUTHENTICATED = "false"
    PUBLIC_BASE_URL = $PublicBaseUrl
    MCP_ALLOWED_HOSTS = $AllowedHosts
    MCP_OAUTH_ENABLED = "true"
    MCP_OAUTH_ISSUER = $PublicBaseUrl
    MCP_OAUTH_RESOURCE = "$PublicBaseUrl/mcp"
    MCP_OAUTH_SCOPE = "youtube.read"
    MCP_OAUTH_STORE = "firestore"
    MCP_OAUTH_CODE_COLLECTION = $OAuthCodeCollection
    YOUTUBE_QUOTA_STORE = "firestore"
    GOOGLE_CLOUD_PROJECT = $ProjectId
    YT_DLP_POT_PROVIDER_ENABLED = "true"
    YOUTUBE_CURSOR_TTL_SECONDS = "86400"
    YOUTUBE_MAX_RESULT_BYTES = "12288"
  }
  $envEntries = @($environment.GetEnumerator() | ForEach-Object {
      [ordered]@{ name = [string]$_.Key; value = [string]$_.Value }
    })
  $envEntries += @(
    [ordered]@{ name = "MCP_ACCESS_TOKEN"; valueSource = @{ secretKeyRef = @{ secret = "youtube-mcp-access-token"; version = $accessVersion } } },
    [ordered]@{ name = "MCP_OAUTH_LOGIN_SECRET"; valueSource = @{ secretKeyRef = @{ secret = "youtube-mcp-oauth-login-secret"; version = $oauthLoginVersion } } },
    [ordered]@{ name = "MCP_OAUTH_SIGNING_SECRET"; valueSource = @{ secretKeyRef = @{ secret = "youtube-mcp-oauth-signing-secret"; version = $oauthSigningVersion } } },
    [ordered]@{ name = "YOUTUBE_CURSOR_SECRET"; valueSource = @{ secretKeyRef = @{ secret = "youtube-mcp-cursor-secret"; version = $cursorSecretVersion } } },
    [ordered]@{ name = "YOUTUBE_API_KEY"; valueSource = @{ secretKeyRef = @{ secret = "youtube-data-api-key"; version = $apiKeyVersion } } }
  )
  $revisionName = "$ServiceName-$RevisionSuffix"
  $body = [ordered]@{
    name = "projects/$ProjectId/locations/$Region/services/$ServiceName"
    ingress = "INGRESS_TRAFFIC_ALL"
    scaling = [ordered]@{ minInstanceCount = 0; maxInstanceCount = 2 }
    template = [ordered]@{
      revision = $revisionName
      labels = [ordered]@{ app = "youtube-mcp-aio"; "git-sha" = $shortSha }
      scaling = [ordered]@{ minInstanceCount = 0; maxInstanceCount = 2 }
      timeout = "300s"
      serviceAccount = $runtimeServiceAccount
      executionEnvironment = "EXECUTION_ENVIRONMENT_GEN2"
      maxInstanceRequestConcurrency = 4
      containers = @(
        [ordered]@{
          name = "mcp"
          image = $immutableImage
          env = $envEntries
          resources = [ordered]@{ limits = [ordered]@{ cpu = "1"; memory = "1Gi" }; cpuIdle = $true; startupCpuBoost = $true }
          ports = @([ordered]@{ name = "http1"; containerPort = 8080 })
          startupProbe = [ordered]@{ timeoutSeconds = 2; periodSeconds = 2; failureThreshold = 30; tcpSocket = @{ port = 8080 } }
          dependsOn = @("pot-provider")
        },
        [ordered]@{
          name = "pot-provider"
          image = $PotProviderImage
          command = @("/usr/local/bin/node")
          args = @(
            "--input-type=module",
            "--eval",
            'const redact=(value)=>typeof value==="string"?value.replace(/(poToken:\s*)\S+/gu,"$1[REDACTED]").replace(/("integrityToken"\s*:\s*")[^"]+/gu,"$1[REDACTED]"):value; for (const method of ["log","debug"]) { const original=console[method].bind(console); console[method]=(...args)=>original(...args.map(redact)); } await import("./build/main.js");'
          )
          resources = [ordered]@{ limits = [ordered]@{ cpu = "0.25"; memory = "512Mi" }; cpuIdle = $true; startupCpuBoost = $true }
          startupProbe = [ordered]@{ timeoutSeconds = 2; periodSeconds = 2; failureThreshold = 30; httpGet = @{ path = "/ping"; port = 4416 } }
        }
      )
    }
    traffic = @(
      [ordered]@{ type = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"; revision = $StableRevision; percent = 100 },
      [ordered]@{ type = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"; revision = $revisionName; percent = 0; tag = "candidate" }
    )
  }
  Invoke-RunServicePatch $body $true > $null
  Invoke-RunServicePatch $body $false > $null
}

function Test-HttpStatus {
  param([string]$Url, [int]$ExpectedStatus)
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Post -ContentType "application/json" -Body "{}"
    $status = [int]$response.StatusCode
  }
  catch {
    if (-not $_.Exception.Response) { throw }
    $status = [int]$_.Exception.Response.StatusCode
  }
  if ($status -ne $ExpectedStatus) { throw "Expected HTTP $ExpectedStatus from '$Url', received $status." }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw "Google Cloud CLI (gcloud) is not installed or is not on PATH." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required for SHA-tagged builds." }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js 24 and npm are required for the frozen MCP SDK smoke client." }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gitSha = (& git -C $projectRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch "^[0-9a-f]{40}$") { throw "The repository HEAD is not a full Git SHA." }
$dirty = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Deployment requires a clean worktree so the SHA identifies the exact build context." }
Push-Location $projectRoot
try {
  & npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed; the smoke client must use package-lock.json." }
}
finally { Pop-Location }

$shortSha = $gitSha.Substring(0, 12)
$revisionNonce = Get-Date -AsUTC -Format "yyyyMMddHHmmss"
$runtimeServiceAccount = "$RuntimeServiceAccountName@$ProjectId.iam.gserviceaccount.com"
$taggedImage = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/${ImageName}:$gitSha"

if (-not (Test-GcloudResource secrets describe youtube-mcp-access-token --project $ProjectId)) { throw "Missing youtube-mcp-access-token. Run provision-gcp.ps1 first." }
if ($RotateAccessToken) { Add-SecretVersion "youtube-mcp-access-token" (New-RandomHex 32) }
$accessVersion = Get-LatestSecretVersion "youtube-mcp-access-token"
$cursorSecretVersion = Get-LatestSecretVersion "youtube-mcp-cursor-secret"
$apiKeyVersion = Get-LatestSecretVersion "youtube-data-api-key"
$oauthLoginVersion = Get-LatestSecretVersion "youtube-mcp-oauth-login-secret"
$oauthSigningVersion = Get-LatestSecretVersion "youtube-mcp-oauth-signing-secret"

Write-Host "[1/6] Building immutable image $taggedImage..." -ForegroundColor Cyan
Push-Location $projectRoot
try { Invoke-Gcloud builds submit . --project $ProjectId --tag $taggedImage --quiet }
finally { Pop-Location }
$digest = (& gcloud artifacts docker images describe $taggedImage --project $ProjectId --format "value(image_summary.digest)").Trim()
if ($LASTEXITCODE -ne 0 -or $digest -notmatch "^sha256:[0-9a-f]{64}$") { throw "Artifact Registry returned no valid digest for '$taggedImage'." }
$immutableImage = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/$ImageName@$digest"

$serviceExists = Test-GcloudResource run services describe $ServiceName --project $ProjectId --region $Region
if (-not $serviceExists) { throw "A stable Cloud Run revision is required before a zero-traffic candidate can be deployed." }
$serviceDocument = Get-ServiceDocument
$serviceUrl = [string]$serviceDocument.status.url
$stableRevision = Get-StableRevision $serviceDocument
$serviceHost = ([Uri]$serviceUrl).Host
$candidateUrl = "https://candidate---$serviceHost"
$candidateHost = ([Uri]$candidateUrl).Host

Write-Host "[2/6] Validating an explicit two-container Cloud Run revision..." -ForegroundColor Cyan
Write-Host "[3/6] Deploying the candidate by digest with production pinned to $stableRevision..." -ForegroundColor Cyan
Deploy-Candidate "$shortSha-candidate-$revisionNonce" $serviceUrl "$serviceHost,$candidateHost" $stableRevision
$serviceDocument = Get-ServiceDocument
$candidateUrl = Get-TaggedUrl $serviceDocument "candidate"
$candidateRevision = Get-TaggedRevision $serviceDocument "candidate"
if (-not $candidateUrl -or -not $candidateRevision) {
  throw "The hardened candidate URL/revision could not be resolved."
}

Write-Host "[4/6] Smoking /health, bearer enforcement, and the five-tool contract..." -ForegroundColor Cyan
$health = Invoke-RestMethod -Uri "$candidateUrl/health" -Method Get
if (-not $health.ok) { throw "Candidate health response did not report ok=true." }
Test-HttpStatus "$candidateUrl/mcp" 401
$oauthMetadata = Invoke-RestMethod -Uri "$candidateUrl/.well-known/oauth-authorization-server" -Method Get
if ($oauthMetadata.issuer -ne $serviceUrl -or -not $oauthMetadata.client_id_metadata_document_supported) {
  throw "Candidate OAuth authorization metadata is invalid."
}
$resourceMetadata = Invoke-RestMethod -Uri "$candidateUrl/.well-known/oauth-protected-resource/mcp" -Method Get
if ($resourceMetadata.resource -ne "$serviceUrl/mcp") { throw "Candidate OAuth resource metadata is invalid." }
$accessToken = (@(& gcloud secrets versions access $accessVersion --secret youtube-mcp-access-token --project $ProjectId) -join "").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) { throw "Could not read the pinned bearer secret version." }
$priorSmokeToken = $env:MCP_SMOKE_ACCESS_TOKEN
try {
  $env:MCP_SMOKE_ACCESS_TOKEN = $accessToken
  & node (Join-Path $PSScriptRoot "smoke-cloud-run.mjs") `
    --url "$candidateUrl/mcp" `
    --videos ($SmokeVideoIds -join ",")
  if ($LASTEXITCODE -ne 0) { throw "Protocol-aware YouTube candidate smoke failed." }
}
finally {
  if ($null -eq $priorSmokeToken) { Remove-Item Env:MCP_SMOKE_ACCESS_TOKEN -ErrorAction SilentlyContinue }
  else { $env:MCP_SMOKE_ACCESS_TOKEN = $priorSmokeToken }
}

Write-Host "[5/6] Candidate smoke passed." -ForegroundColor Green
if ($Promote) {
  Invoke-Gcloud run services update-traffic $ServiceName --project $ProjectId --region $Region --remove-tags candidate --quiet
  Invoke-Gcloud run services update-traffic $ServiceName --project $ProjectId --region $Region --to-revisions "$candidateRevision=100" --quiet
  Write-Host "Promoted candidate to 100%." -ForegroundColor Green
}
else { Write-Host "Candidate remains at 0%; promote it only after approval." -ForegroundColor Yellow }

if ($Promote) {
  Write-Host "[6/6] Saving the promoted bearer credential for this Windows account..." -ForegroundColor Cyan
  [Environment]::SetEnvironmentVariable($TokenEnvironmentVariable, $accessToken, "User")
  Set-Item -Path "Env:$TokenEnvironmentVariable" -Value $accessToken
}
else {
  Write-Host "[6/6] Candidate credential was not persisted because production was not promoted." -ForegroundColor Yellow
}
Write-Host "Image:      $immutableImage"
Write-Host "POT sidecar: $PotProviderImage"
Write-Host "Revision:   $candidateRevision"
Write-Host "Candidate:  $candidateUrl/mcp"
Write-Host "Production: $serviceUrl/mcp"
Write-Host "Health:     $serviceUrl/health"
Write-Host "Secrets:    youtube-mcp-access-token:$accessVersion, youtube-mcp-cursor-secret:$cursorSecretVersion, youtube-data-api-key:$apiKeyVersion"
Write-Host "OAuth:      youtube-mcp-oauth-login-secret:$oauthLoginVersion, youtube-mcp-oauth-signing-secret:$oauthSigningVersion"
