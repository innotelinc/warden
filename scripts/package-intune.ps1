<#
.SYNOPSIS
    Stage the WARDEN Intune payload and build the .intunewin package.

.DESCRIPTION
    Intune has no manifest file to upload for a Win32 app. The package is an
    .intunewin archive produced by the Microsoft Win32 Content Prep Tool
    (IntuneWinAppUtil.exe); the install command, uninstall command, detection
    rule and requirements are then entered in the console or posted from
    deployment/intune/warden-win32app.json.

    This script handles the part that is easy to get wrong: the package content
    root must contain BOTH the setup exe and deploy-warden.ps1, because the
    manifest references the script by relative path and Intune runs the command
    lines with the working directory set to the extracted content root. It also
    cross-checks the manifest against the staged files, so a version bump that
    forgets the manifest fails here instead of on a device.

    With -IntuneWinAppUtil (or IntuneWinAppUtil.exe on PATH) it builds the
    package and verifies the output. Without the tool it stages the payload and
    prints the exact command to run.

.PARAMETER SetupExe
    The installer to package. Defaults to the newest release\WARDEN-Setup-*.exe.

.PARAMETER PayloadDir
    Content root to stage. Defaults to deployment\intune\payload.

.PARAMETER OutputDir
    Where the .intunewin is written. Defaults to deployment\intune\out.

.PARAMETER IntuneWinAppUtil
    Path to IntuneWinAppUtil.exe, if it is not on PATH.

.EXAMPLE
    .\scripts\package-intune.ps1 -IntuneWinAppUtil C:\tools\IntuneWinAppUtil.exe
#>
[CmdletBinding()]
param(
    [string]$SetupExe,
    [string]$PayloadDir,
    [string]$OutputDir,
    [string]$IntuneWinAppUtil
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $PayloadDir) { $PayloadDir = Join-Path $root 'deployment\intune\payload' }
if (-not $OutputDir) { $OutputDir = Join-Path $root 'deployment\intune\out' }

$manifestPath = Join-Path $root 'deployment\intune\warden-win32app.json'

function Step {
    param([string]$Message)
    Write-Host ("== " + $Message) -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)
    Write-Host ("ERROR: " + $Message) -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "Manifest not found: $manifestPath" }
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
    Fail ("Manifest is not valid JSON: " + $_.Exception.Message)
}

if (-not $SetupExe) {
    $candidates = @(Get-ChildItem -LiteralPath (Join-Path $root 'release') -Filter 'WARDEN-Setup-*.exe' -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending)
    if ($candidates.Count -eq 0) { Fail "No release\WARDEN-Setup-*.exe found. Run 'npm run dist' first." }
    $SetupExe = $candidates[0].FullName
}
if (-not (Test-Path -LiteralPath $SetupExe)) { Fail "Installer not found: $SetupExe" }
$SetupExe = (Resolve-Path -LiteralPath $SetupExe).ProviderPath
$setupName = Split-Path -Leaf $SetupExe

Step "Manifest: $manifestPath"
Step "Install:   $($manifest.installCommandLine)"
Step "Uninstall: $($manifest.uninstallCommandLine)"
Step "Detect:    $($manifest.detectionRules[0].path)\$($manifest.detectionRules[0].fileOrFolderName) version $($manifest.detectionRules[0].operator) $($manifest.detectionRules[0].detectionValue)"

if ($manifest.setupFilePath -ne $setupName) {
    Fail ("setupFilePath is '$($manifest.setupFilePath)' but the installer is '$setupName'. Update the manifest (and fileName, installCommandLine hints) for the new version.")
}
if ($manifest.fileName -ne ([IO.Path]::GetFileNameWithoutExtension($setupName) + '.intunewin')) {
    Fail ("fileName is '$($manifest.fileName)' but the content prep tool will produce '$([IO.Path]::GetFileNameWithoutExtension($setupName)).intunewin'.")
}

Step "Staging payload: $PayloadDir"
if (Test-Path -LiteralPath $PayloadDir) {
    Remove-Item -LiteralPath $PayloadDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PayloadDir -Force | Out-Null
Copy-Item -LiteralPath $SetupExe -Destination $PayloadDir -Force
$deployScript = Join-Path $root 'scripts\deploy-warden.ps1'
if (-not (Test-Path -LiteralPath $deployScript)) { Fail "Missing $deployScript" }
Copy-Item -LiteralPath $deployScript -Destination $PayloadDir -Force

# Every file the manifest's command lines reference must exist in the payload.
foreach ($commandLine in @($manifest.installCommandLine, $manifest.uninstallCommandLine)) {
    if ($commandLine -match '-File\s+"?([^"\s]+)"?') {
        $referenced = $Matches[1]
        if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir $referenced))) {
            Fail ("Command line references '$referenced', which is not in the payload. Intune would run it from the content root and fail.")
        }
        Step "Verified payload file: $referenced"
    } else {
        Fail ("Command line does not reference a script with -File, so packaging cannot verify it: $commandLine")
    }
}

# In the package the setup exe sits beside the script with no release\ folder,
# so the deploy script must be able to find it relative to itself.
$payloadScript = Join-Path $PayloadDir 'deploy-warden.ps1'
$scriptText = Get-Content -LiteralPath $payloadScript -Raw
if ($scriptText -notmatch '\$PSScriptRoot') {
    Fail 'deploy-warden.ps1 must resolve the installer relative to $PSScriptRoot, or it cannot find the exe in the Intune content root.'
}
Write-Host ("   payload: " + ((Get-ChildItem -LiteralPath $PayloadDir).Name -join ', '))

$tool = $IntuneWinAppUtil
if (-not $tool) {
    $onPath = Get-Command 'IntuneWinAppUtil.exe' -ErrorAction SilentlyContinue
    if ($onPath) { $tool = $onPath.Source }
}

if (-not $tool) {
    Step 'IntuneWinAppUtil.exe not found - payload staged, package not built.'
    Write-Host ''
    Write-Host 'Download the Microsoft Win32 Content Prep Tool, then run:'
    Write-Host ('  IntuneWinAppUtil.exe -c "{0}" -s "{1}" -o "{2}" -q' -f $PayloadDir, $setupName, $OutputDir)
    Write-Host ''
    Write-Host 'Then upload the resulting .intunewin and use:'
    Write-Host ('  installCommandLine:   ' + $manifest.installCommandLine)
    Write-Host ('  uninstallCommandLine: ' + $manifest.uninstallCommandLine)
    Write-Host 'Detection and requirements: deployment/intune/warden-win32app.json'
    exit 0
}

Step "Building package with $tool"
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
& $tool -c $PayloadDir -s $setupName -o $OutputDir -q
$exit = $LASTEXITCODE

$expected = Join-Path $OutputDir ([IO.Path]::GetFileNameWithoutExtension($setupName) + '.intunewin')
if (-not (Test-Path -LiteralPath $expected)) {
    Fail ("Content prep tool exited $exit and did not produce $expected")
}
$size = [math]::Round((Get-Item -LiteralPath $expected).Length / 1MB, 1)
if ($exit -ne 0) {
    Write-Host ("WARN: content prep tool exited $exit but produced a package.") -ForegroundColor Yellow
}
Step "Built $expected ($size MB) - matches manifest fileName '$($manifest.fileName)'"
exit 0
