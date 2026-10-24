<#
.SYNOPSIS
    Create the WARDEN Intune Win32 app from the manifest and upload its package.

.DESCRIPTION
    Creates a win32LobApp from deployment/intune/warden-win32app.json and uploads
    the .intunewin built by scripts/package-intune.ps1, using Microsoft Graph
    directly (no Graph SDK dependency) so it runs unattended in a pipeline.

    Flow, for reference against Microsoft's documentation:
      1. POST /deviceAppManagement/mobileApps            -> appId
      2. POST .../microsoft.graph.win32LobApp/contentVersions -> contentVersionId
      3. POST .../contentVersions/{v}/files              -> azureStorageUri + fileId
      4. PUT the package to azureStorageUri in chunks    (block blob, Content-Range)
      5. POST .../files/{fileId}/commit                  -> commit, then poll
      6. Poll the app until publishingState settles

    Auth: app registration with the DeviceManagementApps.ReadWrite.All
    application permission (client credentials), or -Interactive for a delegated
    sign-in through the Graph CLI if it is installed.

.PARAMETER ValidateOnly
    Check the manifest, the package and the auth parameters, print the plan, and
    exit without calling Graph. Useful before a first run.

.EXAMPLE
    .\scripts\publish-intune.ps1 -ValidateOnly

.EXAMPLE
    .\scripts\publish-intune.ps1 -TenantId contoso.onmicrosoft.com -ClientId $env:AZ_CLIENT_ID -ClientSecret $env:AZ_CLIENT_SECRET
#>
[CmdletBinding()]
param(
    [string]$IntuneWinPath,
    [string]$ManifestPath,
    [string]$TenantId,
    [string]$ClientId,
    [string]$ClientSecret,
    [switch]$Interactive,
    [switch]$ValidateOnly,
    # Graph requires a multiple of 320 KiB; 5 MiB = 16 x 320 KiB.
    [int]$ChunkSizeMB = 5,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $ManifestPath) { $ManifestPath = Join-Path $root 'deployment\intune\warden-win32app.json' }
if (-not $IntuneWinPath) {
    $outDir = Join-Path $root 'deployment\intune\out'
    $found = @(Get-ChildItem -LiteralPath $outDir -Filter '*.intunewin' -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending)
    if ($found.Count -gt 0) { $IntuneWinPath = $found[0].FullName }
}

$graph = 'https://graph.microsoft.com/v1.0'

function Step { param([string]$Message) Write-Host ("== " + $Message) -ForegroundColor Cyan }
function Fail { param([string]$Message) Write-Host ("ERROR: " + $Message) -ForegroundColor Red; exit 1 }
function Info { param([string]$Message) Write-Host ("   " + $Message) }

# ---------------------------------------------------------------- validation
if (-not (Test-Path -LiteralPath $ManifestPath)) { Fail "Manifest not found: $ManifestPath" }
try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
catch { Fail ("Manifest is not valid JSON: " + $_.Exception.Message) }

if (-not $IntuneWinPath) {
    Fail "No .intunewin found. Build one with scripts\package-intune.ps1, or pass -IntuneWinPath."
}
if (-not (Test-Path -LiteralPath $IntuneWinPath)) { Fail "Package not found: $IntuneWinPath" }
$IntuneWinPath = (Resolve-Path -LiteralPath $IntuneWinPath).ProviderPath
$package = Get-Item -LiteralPath $IntuneWinPath
$astFile = Join-Path $root 'scripts\deploy-warden.ps1'

Step "Package:  $($package.Name) ($([math]::Round($package.Length / 1MB, 1)) MB)"
Step "Manifest: $ManifestPath"
Step "App:      $($manifest.displayName) $($manifest.displayVersion)"

if ($manifest.fileName -ne $package.Name) {
    Fail ("Manifest fileName is '$($manifest.fileName)' but the package is '$($package.Name)'. Rebuild with scripts\package-intune.ps1 or fix the manifest.")
}

$requiredFields = @('displayName', 'publisher', 'installCommandLine', 'uninstallCommandLine', 'setupFilePath', 'detectionRules', 'installExperience', 'returnCodes')
foreach ($field in $requiredFields) {
    if (-not $manifest.PSObject.Properties[$field]) { Fail "Manifest is missing required field '$field'." }
}
if (-not $manifest.detectionRules -or $manifest.detectionRules.Count -eq 0) { Fail 'Manifest has no detection rules; Intune requires at least one.' }

# Chunks must be a multiple of 320 KiB and stay under the request ceiling.
$chunkBytes = [int]($ChunkSizeMB * 1024 * 1024)
if ($chunkBytes -le 0 -or ($chunkBytes % 327680) -ne 0 -or $chunkBytes -gt 60MB) {
    Fail ("ChunkSizeMB=$ChunkSizeMB is invalid: must be a multiple of 0.32 MB and no more than 60 MB.")
}
Info ("chunk size: {0:N0} bytes, {1} chunk(s)" -f $chunkBytes, [math]::Ceiling($package.Length / $chunkBytes))
Info ("detection: {0}\{1} version {2} {3}" -f
    $manifest.detectionRules[0].path, $manifest.detectionRules[0].fileOrFolderName,
    $manifest.detectionRules[0].operator, $manifest.detectionRules[0].detectionValue)
Info ("context:   {0}, restart {1}" -f $manifest.installExperience.runAsAccount, $manifest.installExperience.deviceRestartBehavior)

if ($ValidateOnly) {
    Step 'ValidateOnly: manifest, package and parameters look consistent. No Graph calls made.'
    Step 'Auth was not tested. Run without -ValidateOnly to create the app.'
    exit 0
}

# --------------------------------------------------------------------- auth
function Get-GraphToken {
    if (-not $TenantId -or -not $ClientId -or -not $ClientSecret) {
        Fail 'Provide -TenantId, -ClientId and -ClientSecret for app-only auth, or -Interactive.'
    }
    $body = @{
        client_id     = $ClientId
        client_secret = $ClientSecret
        scope         = 'https://graph.microsoft.com/.default'
        grant_type    = 'client_credentials'
    }
    $uri = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
    try {
        $response = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/x-www-form-urlencoded'
    } catch {
        Fail ("Token request failed: " + $_.Exception.Message)
    }
    return @{ Header = @{ Authorization = 'Bearer ' + $response.access_token } }
}

if ($Interactive) {
    Fail 'Interactive sign-in is not implemented; use app-only credentials (-TenantId/-ClientId/-ClientSecret) with DeviceManagementApps.ReadWrite.All.'
}

Step 'Requesting an access token'
$auth = Get-GraphToken
$headers = $auth.Header

function Invoke-Graph {
    param(
        [string]$Method,
        [string]$Path,
        $Body,
        [int]$Retries = 3
    )
    $uri = if ($Path -like 'https://*') { $Path } else { $graph + $Path }
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            if ($null -ne $Body) {
                $json = $Body | ConvertTo-Json -Depth 12 -Compress
                return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json -ContentType 'application/json'
            }
            return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            $detail = $_.ErrorDetails.Message
            if ($attempt -lt $Retries -and ($status -eq 429 -or ($status -ge 500 -and $status -lt 600))) {
                $wait = [math]::Pow(2, $attempt)
                Write-Host ("   retryable HTTP $status, waiting ${wait}s") -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
                continue
            }
            Fail ("Graph $Method $Path failed (HTTP $status): $detail")
        }
    }
}

# ---------------------------------------------------------------- create app
$body = $manifest | ConvertTo-Json -Depth 12 | ConvertFrom-Json
Step 'Creating the app object'
$app = Invoke-Graph -Method Post -Path '/deviceAppManagement/mobileApps' -Body $body
$appId = $app.id
Info "appId: $appId"

Step 'Creating content version'
$version = Invoke-Graph -Method Post -Path "/deviceAppManagement/mobileApps/$appId/microsoft.graph.win32LobApp/contentVersions" -Body @{}
$versionId = $version.id
Info "contentVersionId: $versionId"

Step 'Requesting an upload URI'
$fileBody = @{
    '@odata.type'   = '#microsoft.graph.mobileAppContentFile'
    'name'          = $package.Name
    'size'          = $package.Length
    'sizeEncrypted' = $package.Length
    'manifest'      = $null
}
$fileEntry = Invoke-Graph -Method Post -Path "/deviceAppManagement/mobileApps/$appId/microsoft.graph.win32LobApp/contentVersions/$versionId/files" -Body $fileBody
$fileId = $fileEntry.id
$uploadUri = $fileEntry.azureStorageUri
if (-not $uploadUri) { Fail 'Graph did not return an azureStorageUri for the upload.' }
Info "fileId: $fileId"

Step ("Uploading {0:N1} MB in {1} chunk(s)" -f ($package.Length / 1MB), [math]::Ceiling($package.Length / $chunkBytes))
$stream = [IO.File]::OpenRead($IntuneWinPath)
try {
    $buffer = New-Object byte[] $chunkBytes
    $offset = 0
    $total = $package.Length
    while ($offset -lt $total) {
        $read = $stream.Read($buffer, 0, [math]::Min($chunkBytes, $total - $offset))
        if ($read -le 0) { break }
        $chunk = New-Object byte[] $read
        [Array]::Copy($buffer, 0, $chunk, 0, $read)
        $rangeEnd = $offset + $read - 1
        $putHeaders = @{
            'x-ms-blob-type' = 'BlockBlob'
            'Content-Range'  = "bytes $offset-$rangeEnd/$total"
        }
        $attempt = 0
        while ($true) {
            $attempt++
            try {
                Invoke-RestMethod -Method Put -Uri $uploadUri -Headers $putHeaders -Body $chunk -ContentType 'application/octet-stream' | Out-Null
                break
            } catch {
                if ($attempt -ge 3) { Fail ("Chunk upload failed at offset $offset : " + $_.Exception.Message) }
                Start-Sleep -Seconds $attempt
            }
        }
        $offset = $rangeEnd + 1
        $pct = [math]::Min(100, [int](100 * $offset / $total))
        Write-Host ("   uploaded {0,3}%" -f $pct) -NoNewline
        Write-Host "`r" -NoNewline
    }
    Write-Host ''
} finally {
    $stream.Dispose()
}

Step 'Committing the file'
Invoke-Graph -Method Post -Path "/deviceAppManagement/mobileApps/$appId/microsoft.graph.win32LobApp/contentVersions/$versionId/files/$fileId/commit" -Body @{ fileEncryptionInfo = $null } | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$state = ''
while ((Get-Date) -lt $deadline) {
    $status = Invoke-Graph -Method Get -Path "/deviceAppManagement/mobileApps/$appId/microsoft.graph.win32LobApp/contentVersions/$versionId/files/$fileId"
    $state = $status.uploadState
    if ($state -eq 'commitFileSuccess') { break }
    if ($state -eq 'commitFileFailed') { Fail 'Intune reported commitFileFailed for the package upload.' }
    Start-Sleep -Seconds 5
}
if ($state -ne 'commitFileSuccess') { Fail "Upload did not commit within $TimeoutSeconds seconds (last state: $state)." }
Info 'package committed'

Step 'Waiting for the app to finish processing'
$final = $null
while ((Get-Date) -lt $deadline) {
    $current = Invoke-Graph -Method Get -Path "/deviceAppManagement/mobileApps/$appId"
    $final = $current.publishingState
    if ($final -eq 'published' -or $final -eq 'failed') { break }
    Start-Sleep -Seconds 5
}
Info "publishingState: $final"

if ($final -eq 'failed') {
    Fail "Intune failed to process the app. Check the app in the console (appId $appId)."
}

Step "Created '$($manifest.displayName)' with appId $appId"
Write-Host ''
Write-Host 'Next: assign the app to a group in the Intune console. Nothing is assigned yet, so nothing installs.'
exit 0
