<#
.SYNOPSIS
    Unattended install, verify and uninstall for WARDEN (Intune Win32 / SCCM).

.DESCRIPTION
    One script, three actions, so a single package covers install, detection and
    uninstall:

        -Action Install     install (idempotent; safe for Intune retries)
        -Action Detect      exit 0 when installed, 1 when not
        -Action Uninstall   remove, using the registered QuietUninstallString

    WARDEN's setup exe supports two install modes:

        per-user      %LOCALAPPDATA%\Programs\WARDEN   + HKCU uninstall entry
        per-machine   %ProgramFiles%\WARDEN            + HKLM uninstall entry  (/allusers)

    Intune Win32 apps run as SYSTEM by default. A per-user install started as
    SYSTEM writes to the SYSTEM profile, where no interactive user can see it,
    so this script refuses that combination instead of producing an install that
    silently "succeeds" and then appears missing. Give the app a SYSTEM context
    with -Scope Machine, or set Install behavior to "User" and use -Scope User.

    Exit codes: 0 success, 1 failure, 1603 fatal install error, 3010 success but
    a reboot is required. Detect returns 0/1 only, per the Intune contract.

.PARAMETER Action
    Install (default), Uninstall or Detect.

.PARAMETER Scope
    Auto (default), User or Machine. Auto resolves to Machine under SYSTEM or an
    elevated session, otherwise User.

.PARAMETER InstallerPath
    The setup exe. Defaults to the newest release\WARDEN-Setup-*.exe beside this
    script.

.PARAMETER InstallDir
    Optional target directory for -Scope Machine or User. Passed through as
    NSIS /D, which takes the rest of the command line and must be last.

.PARAMETER KeepUserData
    Leave %APPDATA%\WARDEN (settings, allowlists, history) in place on uninstall.
    Without it, profile data is removed: current user always, all local profiles
    when running as SYSTEM.

.PARAMETER TimeoutSeconds
    How long to wait for the installer or uninstaller to finish. Default 300.

.PARAMETER LogPath
    Log file. Defaults to %ProgramData%\WARDEN-Deploy\deploy.log when writable,
    otherwise %TEMP%\WARDEN-deploy.log.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy-warden.ps1 -Action Install -Scope Machine

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy-warden.ps1 -Action Detect

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy-warden.ps1 -Action Uninstall -KeepUserData
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Detect')]
    [string]$Action = 'Install',

    [ValidateSet('Auto', 'User', 'Machine')]
    [string]$Scope = 'Auto',

    [string]$InstallerPath,
    [string]$InstallDir,
    [switch]$KeepUserData,
    [int]$TimeoutSeconds = 300,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$script:ExitSuccess = 0
$script:ExitFailure = 1
$script:ExitInstallFailure = 1603
$script:ExitRebootRequired = 3010

$script:UninstallRoots = @(
    @{ Scope = 'Machine'; Path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' },
    @{ Scope = 'Machine'; Path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' },
    @{ Scope = 'User';    Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' }
)

function Resolve-LogFile {
    param([string]$Requested)
    if ($Requested) { return $Requested }
    $dir = Join-Path $env:ProgramData 'WARDEN-Deploy'
    try {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $probe = Join-Path $dir '.writeprobe'
        Set-Content -LiteralPath $probe -Value 'ok' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return (Join-Path $dir 'deploy.log')
    } catch {
        return (Join-Path $env:TEMP 'WARDEN-deploy.log')
    }
}

$script:LogFile = Resolve-LogFile -Requested $LogPath

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )
    $line = '{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}' -f (Get-Date), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        default { Write-Host $line }
    }
    try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Test-IsSystem {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return $id.User.IsWellKnown([Security.Principal.WellKnownSidType]::LocalSystemSid)
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-Scope {
    param([string]$Requested)
    if ($Requested -ne 'Auto') { return $Requested }
    if ((Test-IsSystem) -or (Test-IsAdmin)) { return 'Machine' }
    return 'User'
}

function Find-Installer {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "Installer not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).ProviderPath
    }
    # Intune extracts the package and runs this from the content root, where the
    # setup exe sits beside the script. In the repo the exe lives in release\, and
    # an operator may run it from anywhere, so search all three locations.
    $searchDirs = @(
        $PSScriptRoot,
        (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
        (Get-Location).Path
    )
    foreach ($dir in $searchDirs) {
        if (-not $dir) { continue }
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $candidates = @(Get-ChildItem -LiteralPath $dir -Filter 'WARDEN-Setup-*.exe' -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending)
        if ($candidates.Count -gt 0) { return $candidates[0].FullName }
    }
    throw ('No WARDEN-Setup-*.exe beside the script ({0}), in release\, or in the working directory. Build one with npm run dist, or pass -InstallerPath.' -f $PSScriptRoot)
}

function Get-WardenInstall {
    $found = @()
    foreach ($root in $script:UninstallRoots) {
        if (-not (Test-Path -LiteralPath $root.Path)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $root.Path -ErrorAction SilentlyContinue)) {
            $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if (-not $props) { continue }
            if ($props.DisplayName -notlike 'WARDEN*') { continue }
            $found += [pscustomobject]@{
                Scope                = $root.Scope
                KeyPath              = $key.PSPath
                DisplayName          = $props.DisplayName
                Version              = $props.DisplayVersion
                InstallLocation      = $props.InstallLocation
                UninstallString      = $props.UninstallString
                QuietUninstallString = $props.QuietUninstallString
            }
        }
    }
    return $found
}

function Get-WardenProcess {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like 'WARDEN*' -or $_.ProcessName -like 'Uninstall*'
    })
}

function Wait-Until {
    param([scriptblock]$Condition, [int]$Seconds, [int]$IntervalMs = 500)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $false
}

function Split-CommandLine {
    param([string]$CommandLine)
    $trimmed = $CommandLine.Trim()
    if ($trimmed -match '^"([^"]+)"\s*(.*)$') {
        return [pscustomobject]@{ Exe = $Matches[1]; Args = $Matches[2].Trim() }
    }
    $space = $trimmed.IndexOf(' ')
    if ($space -lt 0) { return [pscustomobject]@{ Exe = $trimmed; Args = '' } }
    return [pscustomobject]@{ Exe = $trimmed.Substring(0, $space); Args = $trimmed.Substring($space + 1).Trim() }
}

function Assert-Installed {
    param([string]$ExpectedScope, [int]$Seconds)
    $ok = Wait-Until -Seconds $Seconds -Condition {
        $entry = Get-WardenInstall | Where-Object { $_.Scope -eq $ExpectedScope } | Select-Object -First 1
        if (-not $entry) { return $false }
        if (-not $entry.InstallLocation) { return $false }
        return (Test-Path -LiteralPath (Join-Path $entry.InstallLocation 'WARDEN.exe'))
    }
    if (-not $ok) { return $null }
    $entry = Get-WardenInstall | Where-Object { $_.Scope -eq $ExpectedScope } | Select-Object -First 1
    $exe = Join-Path $entry.InstallLocation 'WARDEN.exe'
    $entry | Add-Member -NotePropertyName FileVersion -NotePropertyValue (
        (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
    ) -Force
    return $entry
}

function Invoke-Install {
    param([string]$ResolvedScope, [string]$TargetDir, [int]$Seconds)
    $installer = Find-Installer -Explicit $InstallerPath

    if (-not [Environment]::Is64BitOperatingSystem) {
        Write-Log 'WARDEN ships x64 only; this host is 32-bit.' 'ERROR'
        return $script:ExitInstallFailure
    }

    $running = Get-WardenProcess
    if ($running) {
        Write-Log ('Another WARDEN or uninstaller process is running: {0}' -f (($running | ForEach-Object { $_.ProcessName }) -join ', ')) 'WARN'
    }

    $existing = Get-WardenInstall
    if ($existing) {
        foreach ($entry in $existing) {
            Write-Log ('Existing install: {0} {1} ({2}) at {3}' -f
                $entry.DisplayName, $entry.Version, $entry.Scope, $entry.InstallLocation)
        }
        $same = $existing | Where-Object { $_.Scope -eq $ResolvedScope } | Select-Object -First 1
        if ($same -and -not $TargetDir -and $same.InstallLocation -and (Test-Path -LiteralPath (Join-Path $same.InstallLocation 'WARDEN.exe'))) {
            Write-Log ('Already installed ({0}) at {1}; treating as success.' -f $same.Version, $same.InstallLocation)
            return $script:ExitSuccess
        }
        $other = $existing | Where-Object { $_.Scope -ne $ResolvedScope } | Select-Object -First 1
        if ($other) {
            Write-Log ('A {0}-scope install exists while installing {1}-scope; both will be registered. Uninstall the other scope first if that is unintended.' -f $other.Scope, $ResolvedScope) 'WARN'
        }
    }

    if ($ResolvedScope -eq 'Machine' -and -not ((Test-IsSystem) -or (Test-IsAdmin))) {
        Write-Log 'Machine scope needs an elevated session or SYSTEM. Rerun from an elevated shell, or use -Scope User.' 'ERROR'
        return $script:ExitFailure
    }

    if ($ResolvedScope -eq 'User' -and (Test-IsSystem)) {
        Write-Log 'Refusing a per-user install under SYSTEM: it would land in the SYSTEM profile where no user can see it. Use -Scope Machine, or set the Intune app Install behavior to "User".' 'ERROR'
        return $script:ExitFailure
    }

    # /D must be last, unquoted, and takes the remainder of the command line.
    $argLine = '/S ' + $(if ($ResolvedScope -eq 'Machine') { '/allusers' } else { '/currentuser' })
    if ($TargetDir) {
        if ($TargetDir -match '"') {
            Write-Log 'InstallDir must not contain quotes; NSIS /D takes the rest of the line.' 'ERROR'
            return $script:ExitInstallFailure
        }
        $argLine = $argLine + ' /D=' + $TargetDir.TrimEnd('\')
    }

    Write-Log ('Installing {0} scope: "{1}" {2}' -f $ResolvedScope, $installer, $argLine)
    $proc = Start-Process -FilePath $installer -ArgumentList $argLine -PassThru
    if (-not $proc.WaitForExit($Seconds * 1000)) {
        Write-Log ('Installer did not finish within {0}s; stopping it.' -f $Seconds) 'ERROR'
        try { $proc.Kill() } catch { }
        return $script:ExitInstallFailure
    }
    Write-Log ('Installer exit code: {0}' -f $proc.ExitCode)

    $entry = Assert-Installed -ExpectedScope $ResolvedScope -Seconds $Seconds
    if (-not $entry) {
        Write-Log ('Install verification failed: no {0}-scope uninstall entry with a WARDEN.exe at its InstallLocation.' -f $ResolvedScope) 'ERROR'
        return $script:ExitInstallFailure
    }

    Write-Log ('Verified: {0}, version {1}, file version {2}' -f $entry.DisplayName, $entry.Version, $entry.FileVersion)
    Write-Log ('InstallLocation registry value: {0}' -f $entry.InstallLocation)
    return $script:ExitSuccess
}

function Remove-UserData {
    $targets = @()
    if ($env:APPDATA) { $targets += (Join-Path $env:APPDATA 'WARDEN') }
    if (Test-IsSystem) {
        foreach ($profile in @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $profile.FullName 'AppData\Roaming\WARDEN'
            if ($targets -notcontains $candidate) { $targets += $candidate }
        }
    }
    $removed = 0
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target) {
            try {
                Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
                Write-Log ('Removed profile data: {0}' -f $target)
                $removed++
            } catch {
                Write-Log ('Could not remove {0}: {1}' -f $target, $_.Exception.Message) 'WARN'
            }
        }
    }
    if ($removed -eq 0) { Write-Log 'No profile data to remove.' }
}

function Invoke-Uninstall {
    param([int]$Seconds)
    $installs = @(Get-WardenInstall)
    if ($installs.Count -eq 0) {
        Write-Log 'No WARDEN installation registered; nothing to uninstall.'
    }

    foreach ($entry in $installs) {
        $running = Get-WardenProcess | Where-Object { $_.ProcessName -eq 'WARDEN' }
        if ($running) {
            Write-Log ('Stopping running WARDEN process(es): {0}' -f (($running | ForEach-Object { $_.Id }) -join ', ')) 'WARN'
            $running | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }

        $command = $entry.QuietUninstallString
        if (-not $command) {
            if (-not $entry.InstallLocation) {
                Write-Log 'No QuietUninstallString or InstallLocation; assuming Program Files.' 'WARN'
                $entry.InstallLocation = Join-Path $env:ProgramFiles 'WARDEN'
            }
            $fallbackExe = Join-Path $entry.InstallLocation 'Uninstall WARDEN.exe'
            $switch = if ($entry.Scope -eq 'Machine') { '/allusers' } else { '/currentuser' }
            $command = '"{0}" {1} /S' -f $fallbackExe, $switch
            Write-Log 'No QuietUninstallString; falling back to the install directory.' 'WARN'
        }

        $parts = Split-CommandLine -CommandLine $command
        if (-not (Test-Path -LiteralPath $parts.Exe)) {
            Write-Log ('Uninstaller missing at {0}; removing the registry entry only.' -f $parts.Exe) 'WARN'
        } else {
            Write-Log ('Uninstalling {0} scope: "{1}" {2}' -f $entry.Scope, $parts.Exe, $parts.Args)
            $proc = Start-Process -FilePath $parts.Exe -ArgumentList $parts.Args -PassThru
            if (-not $proc.WaitForExit($Seconds * 1000)) {
                Write-Log ('Uninstaller did not finish within {0}s; stopping it.' -f $Seconds) 'ERROR'
                try { $proc.Kill() } catch { }
                return $script:ExitFailure
            }
            Write-Log ('Uninstaller exit code: {0}' -f $proc.ExitCode)
        }

        # NSIS hands off to a temp copy, so wait on the observable result, not the exit code.
        $gone = Wait-Until -Seconds $Seconds -Condition {
            $stillKeyed = Get-WardenInstall | Where-Object { $_.KeyPath -eq $entry.KeyPath }
            if ($stillKeyed) { return $false }
            if ($entry.InstallLocation -and (Test-Path -LiteralPath $entry.InstallLocation)) { return $false }
            return $true
        }
        if (-not $gone) {
            Write-Log ('Uninstall incomplete: entry or directory still present for {0}.' -f $entry.Scope) 'ERROR'
            return $script:ExitFailure
        }
        Write-Log ('Removed {0} scope install and its registry entry.' -f $entry.Scope)
    }

    $remaining = @(Get-WardenInstall)
    if ($remaining.Count -gt 0) {
        Write-Log ('Still registered after uninstall: {0}' -f (($remaining | ForEach-Object { $_.Scope }) -join ', ')) 'ERROR'
        return $script:ExitFailure
    }

    if ($KeepUserData) {
        Write-Log 'Keeping profile data (-KeepUserData).'
    } else {
        Remove-UserData
    }

    $temp = Join-Path $env:TEMP 'WARDEN'
    if (Test-Path -LiteralPath $temp) {
        try {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
            Write-Log ('Removed portable extraction directory: {0}' -f $temp)
        } catch {
            Write-Log ('Could not remove portable extraction directory {0}: {1}' -f $temp, $_.Exception.Message) 'WARN'
        }
    }

    Write-Log 'Uninstall verified: no registry entry, no install directory.'
    return $script:ExitSuccess
}

function Invoke-Detect {
    $installs = @(Get-WardenInstall)
    if ($installs.Count -eq 0) {
        Write-Host 'WARDEN not detected.'
        return $script:ExitFailure
    }
    $healthy = $false
    foreach ($entry in $installs) {
        $exe = if ($entry.InstallLocation) { Join-Path $entry.InstallLocation 'WARDEN.exe' } else { $null }
        if ($exe -and (Test-Path -LiteralPath $exe)) {
            Write-Host ('WARDEN {0} detected ({1}) at {2}' -f $entry.Version, $entry.Scope, $entry.InstallLocation)
            Write-Log ('Detect: found {0} {1} ({2})' -f $entry.DisplayName, $entry.Version, $entry.Scope)
            $healthy = $true
        } else {
            Write-Host ('WARDEN {0} registered ({1}) but WARDEN.exe is missing at {2}' -f $entry.Version, $entry.Scope, $entry.InstallLocation)
            Write-Log ('Detect: stale entry for {0}; binary missing at {1}' -f $entry.Scope, $entry.InstallLocation) 'WARN'
        }
    }
    if ($healthy) { return $script:ExitSuccess }
    return $script:ExitFailure
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
Write-Log '=============================================================='
Write-Log ('WARDEN deploy: action={0} scope={1} pid={2} system={3} admin={4}' -f
    $Action, $Scope, $PID, (Test-IsSystem), (Test-IsAdmin))

try {
    $resolved = Resolve-Scope -Requested $Scope
    switch ($Action) {
        'Install'   { $code = Invoke-Install   -ResolvedScope $resolved -TargetDir $InstallDir -Seconds $TimeoutSeconds }
        'Uninstall' { $code = Invoke-Uninstall -Seconds $TimeoutSeconds }
        'Detect'    { $code = Invoke-Detect }
    }
} catch {
    Write-Log ('Unhandled error: {0}' -f $_.Exception.Message) 'ERROR'
    $code = $script:ExitFailure
}

Write-Log ('Result: {0}' -f $(switch ($code) {
    0    { 'success' }
    3010 { 'success, reboot required' }
    1603 { 'fatal install error' }
    default { 'failure' }
}))
exit $code
