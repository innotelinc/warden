#Requires -Version 5.1
<#
.SYNOPSIS
  Signs the WARDEN installers with a local code-signing certificate.

.DESCRIPTION
  Authenticode-signs every .exe in release/ so the binary carries a publisher
  name, a digest and an RFC 3161 timestamp instead of a bare "Unknown publisher".

  With no parameters this creates a self-signed code-signing certificate in the
  current user's store (reused on later runs), exports it to
  %USERPROFILE%\.warden-signing\ so CI or another machine can sign with the same
  identity, and signs the build. That certificate is free but no public CA
  vouches for it: Windows shows "Unknown publisher" until the certificate is
  installed in Trusted Root + Trusted Publisher, which -TrustCurrentUser does
  for the current account. For fleets, distribute the exported .cer by GPO.

  A publicly trusted free certificate is only available through SignPath
  Foundation's open-source programme; see README "Code signing".

.PARAMETER Thumbprint
  Use an existing certificate from Cert:\CurrentUser\My instead of the
  self-signed one.

.PARAMETER PfxPath
  Sign with a .pfx (for example a CA-issued certificate). Pair with
  -PfxPassword or set CSC_KEY_PASSWORD.

.PARAMETER TrustCurrentUser
  Add the signing certificate to this user's Trusted Root and Trusted Publisher
  stores so Get-AuthenticodeSignature reports Valid locally. Never touches
  LocalMachine, so no administrator rights are needed or requested.

.PARAMETER Files
  Explicit files to sign. Defaults to every release\*.exe.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-build.ps1 -TrustCurrentUser

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-build.ps1 -PfxPath C:\certs\warden.pfx
#>
[CmdletBinding()]
param(
  [string]$Subject = 'CN=innotelinc, O=innotelinc, C=US',
  [string]$Thumbprint,
  [string]$PfxPath,
  [string]$PfxPassword = $env:CSC_KEY_PASSWORD,
  [string]$CertDir = (Join-Path $env:USERPROFILE '.warden-signing'),
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [string[]]$Files,
  [switch]$TrustCurrentUser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# The Cert: drive belongs to Microsoft.PowerShell.Security, which is located
# through PSModulePath. Started from a PowerShell 7 session this process inherits
# PS7's value, the provider never loads, and the first Get-ChildItem Cert:\ throws
# DriveNotFound — a missing module reported as a missing certificate. Say which
# one it is, rather than leaving that error in the middle of a signing run.
if (-not (Test-Path Cert:\)) {
  try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop } catch { }
}
if (-not (Test-Path Cert:\)) {
  throw "No certificate provider: the Cert: drive is missing, so PSModulePath ('$env:PSModulePath') cannot see Windows PowerShell's own modules. Run this from a plain Windows PowerShell console, or clear PSModulePath for this process."
}

function Write-Step([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }

function Get-SigningCertificate {
  if ($PfxPath) {
    if (-not (Test-Path -LiteralPath $PfxPath)) { throw "PFX not found: $PfxPath" }
    $secure = if ($PfxPassword) { ConvertTo-SecureString $PfxPassword -AsPlainText -Force } else { $null }
    Write-Step "Loading certificate from $PfxPath"
    return Get-PfxCertificate -FilePath $PfxPath -Password $secure
  }

  if ($Thumbprint) {
    $found = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint }
    if (-not $found) { throw "No certificate with thumbprint $Thumbprint in Cert:\CurrentUser\My" }
    return $found
  }

  $existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object {
      $_.Subject -like "*$($Subject -replace '^CN=([^,]+).*', '$1')*" -and
      $_.HasPrivateKey -and
      ($_.EnhancedKeyUsageList.ObjectId.Value -contains '1.3.6.1.5.5.7.3.3') -and
      $_.NotAfter -gt (Get-Date).AddDays(30)
    } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

  if ($existing) {
    Write-Step "Reusing certificate $($existing.Thumbprint) (expires $($existing.NotAfter.ToString('yyyy-MM-dd')))"
    return $existing
  }

  Write-Step 'Creating a self-signed code-signing certificate'
  return New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(3) `
    -TextExtension @(
      '2.5.29.37={text}1.3.6.1.5.5.7.3.3',
      '2.5.29.19={text}ca=false'
    )
}

function Export-SigningIdentity($certificate) {
  if ($PfxPath -or $Thumbprint) { return }
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

  $pfx = Join-Path $CertDir 'warden-codesign.pfx'
  $passwordFile = Join-Path $CertDir 'warden-codesign.pfx.password'
  $cer = Join-Path $CertDir 'warden-codesign.cer'

  if (-not (Test-Path $pfx)) {
    $plain = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password $secure | Out-Null
    Set-Content -LiteralPath $passwordFile -Value $plain -NoNewline -Encoding ascii
    Add-Content -LiteralPath $passwordFile -Value '' -Encoding ascii
    Write-Step "Exported private key to $pfx (password in warden-codesign.pfx.password, owner-only ACL)"
  }
  Export-Certificate -Cert $certificate -FilePath $cer -Type CERT | Out-Null

  # Private key material: owner-only, inheritance cut. Done with the current
  # token's SID rather than a username string, which does not always resolve.
  try {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $CertDir -AclObject $acl
  } catch {
    Write-Warning "Could not tighten ACL on ${CertDir}: $($_.Exception.Message)"
  }

  Write-Step "Public certificate for trust deployment: $cer"
}

function Trust-Certificate($certificate) {
  foreach ($name in @('Root', 'TrustedPublisher')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, 'CurrentUser')
    $store.Open('ReadWrite')
    try {
      if ($store.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }) {
        continue
      }
      $store.Add($certificate)
      Write-Step "Added to Cert:\CurrentUser\$name"
    } catch {
      # Windows guards the root store with a confirmation dialog that cannot be
      # suppressed. Adding it needs a human to click Yes, once.
      Write-Warning "Could not add to Cert:\CurrentUser\${name}: $($_.Exception.Message)"
      Write-Warning "Import the .cer yourself, or add it with Group Policy."
    } finally {
      $store.Close()
    }
  }
}

$targets = if ($Files) { $Files } else { Get-ChildItem (Join-Path $root 'release') -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } }
if (-not $targets) { throw 'No .exe files to sign. Run npm run dist first.' }

$certificate = Get-SigningCertificate
Export-SigningIdentity $certificate
if ($TrustCurrentUser) { Trust-Certificate $certificate }

$failed = 0
foreach ($file in $targets) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing file: $file" }
  Write-Step "Signing $(Split-Path -Leaf $file)"
  $signature = Set-AuthenticodeSignature -FilePath $file -Certificate $certificate -TimestampServer $TimestampUrl -HashAlgorithm SHA256
  if ($signature.Status -eq 'NotSigned') {
    Write-Host "   FAILED: $($signature.StatusMessage)" -ForegroundColor Red
    $failed += 1
    continue
  }

  $check = Get-AuthenticodeSignature -FilePath $file
  $stamped = if ($check.TimeStamperCertificate) { 'timestamped' } else { 'NOT timestamped' }
  Write-Host ("   {0} · {1} · {2} · {3}" -f $check.Status, $check.SignerCertificate.Subject, $check.SignerCertificate.Thumbprint, $stamped)
  if ($check.Status -notin @('Valid', 'NotTrusted', 'UnknownError')) { $failed += 1 }
}

if ($failed -gt 0) {
  throw "$failed file(s) are not signed. Fix the certificate and re-run."
}
Write-Host ''
Write-Host 'Signed. On this machine the certificate is trusted, so the files show as valid;' -ForegroundColor Green
Write-Host 'on other machines either deploy warden-codesign.cer by GPO or expect "Unknown publisher".'
