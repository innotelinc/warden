/**
 * Check a password against the Windows account WARDEN runs as.
 *
 * Electron has no API for this: the only supported way to verify a local
 * credential is `LogonUserW`. Calling it through PowerShell + P/Invoke keeps
 * the app free of a native module (which would need a rebuild per Electron
 * version) at the cost of one short-lived process per unlock attempt.
 *
 * The password is written to the child's stdin, never to argv, its
 * environment, or a temporary file, and it is not logged on any path.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

/**
 * What Windows Hello said.
 *
 * `LogonUserW` cannot check a PIN: a Windows sign-in PIN is not the account
 * password and is never handed to a caller, it is verified by the Hello stack
 * against a key in the local NGC container. Asking for the PIN in a text box was
 * therefore the lock screen refusing the credential the operator actually uses
 * every day. `UserConsentVerifier` is the supported way to ask the OS to verify
 * the signed-in user, and it accepts whatever they have enrolled — PIN,
 * fingerprint or face — without the secret ever leaving Windows.
 */
export type HelloOutcome =
  | 'verified'
  | 'cancelled'
  | 'not-configured'
  | 'not-present'
  | 'disabled'
  | 'busy'
  | 'retries-exhausted'
  | 'unavailable'

/**
 * What to tell the operator when Hello did not verify.
 *
 * Every branch ends in the same place — the password field below the button —
 * because a lock screen must always have a way in that does not depend on a
 * sensor, a PIN enrolment or a policy.
 */
export function helloMessage(outcome: HelloOutcome): string {
  switch (outcome) {
    case 'cancelled':
      return 'Windows Hello was cancelled. Try again, or enter your account password.'
    case 'not-configured':
      return 'Windows Hello is not set up for this account. Enter your account password.'
    case 'not-present':
      return 'No Windows Hello device is available here. Enter your account password.'
    case 'disabled':
      return 'Windows Hello is disabled by policy on this machine. Enter your account password.'
    case 'busy':
      return 'Windows Hello is busy with another prompt. Try again, or enter your account password.'
    case 'retries-exhausted':
      return 'Too many Windows Hello attempts. Enter your account password.'
    case 'unavailable':
      return 'Windows Hello could not be reached. Enter your account password.'
    case 'verified':
      return ''
  }
}

/**
 * Whether Windows Hello is usable on this machine, checked without asking.
 *
 * `CheckAvailabilityAsync` interrogates the verifier without showing a prompt,
 * so WARDEN can tell the operator *before* the screen is covered whether their
 * PIN is going to work — and point them at the password field if it is not.
 */
export type HelloAvailability =
  | 'available'
  /**
   * Hello is enrolled for this user but the verifier would not answer. The
   * availability API is the only caller-facing way to ask, and on some machines
   * it fails while the PIN prompt itself works perfectly — usually a WinRT or
   * PowerShell projection problem rather than anything to do with enrolment.
   * Reporting that as "unavailable" disabled the button on a machine whose owner
   * signs in with a PIN every day, so it gets its own state: the button stays
   * live, and the password remains the fallback if no prompt appears.
   */
  | 'enrolled'
  | 'not-configured'
  | 'not-present'
  | 'disabled'
  | 'busy'
  | 'unavailable'

function availabilityOf(value: string): HelloAvailability {
  switch (value) {
    case 'available':
      return 'available'
    case 'notconfiguredforuser':
      return 'not-configured'
    case 'devicenotpresent':
      return 'not-present'
    case 'disabledbypolicy':
      return 'disabled'
    case 'devicebusy':
      return 'busy'
    default:
      return 'unavailable'
  }
}

export function parseHelloAvailability(output: string): HelloAvailability {
  return availabilityOf((/HELLO_AVAIL:([A-Za-z]+)/.exec(output)?.[1] ?? '').toLowerCase())
}

/**
 * The fallback signal: is there a Hello container for this user at all?
 *
 * `%LOCALAPPDATA%\Microsoft\Ngc` holds one container per enrolled credential
 * (the PIN, then any biometrics), and a container always carries `.dat` files.
 * That is a filesystem fact rather than an API call, so it still answers when
 * the WinRT projection in the child process does not.
 */
export function helloEnrolled(output: string): boolean {
  return /HELLO_ENROLLED:(yes)/i.test(output)
}

/**
 * Combine the verifier's answer with the enrolment signal.
 *
 * Only silence is overruled. `NotConfiguredForUser`, `DisabledByPolicy`, `Busy`
 * and `Available` are statements the verifier made about this account, and a
 * container on disk does not get to contradict them.
 */
export function resolveHelloAvailability(output: string): HelloAvailability {
  const availability = parseHelloAvailability(output)
  if (availability === 'unavailable' || availability === 'not-present') {
    if (helloEnrolled(output)) return 'enrolled'
  }
  return availability
}

/** One sentence for the UI: what works here, right now. */
export function helloAvailabilityMessage(availability: HelloAvailability): string {
  switch (availability) {
    case 'available':
      return 'Windows Hello is ready — your PIN, fingerprint or face unlocks this screen.'
    case 'not-configured':
      return 'Windows Hello is not set up for this account. The account password unlocks this screen.'
    case 'not-present':
      return 'This machine has no Windows Hello device. The account password unlocks this screen.'
    case 'disabled':
      return 'Windows Hello is disabled by policy here. The account password unlocks this screen.'
    case 'busy':
      return 'Windows Hello is busy with another prompt right now. The account password still works.'
    case 'enrolled':
      return 'Windows Hello is enrolled here but the verifier did not answer. Try the Hello button; if no prompt appears, enter your account password.'
    case 'unavailable':
      return 'Windows Hello could not be queried and no enrolment was found. The account password unlocks this screen.'
  }
}

const HELLO_AVAILABILITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$state = 'Unavailable'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($operation))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  # Available is zero, so this must not be tested for truthiness.
  $state = [string]$result
  if ([string]::IsNullOrWhiteSpace($state)) { $state = 'Unavailable' }
} catch {
  $state = 'Unavailable'
}
"HELLO_AVAIL:$state"
# Fallback signal, independent of WinRT: an NGC container exists for this user.
$enrolled = 'no'
if ($state -eq 'Available') {
  $enrolled = 'yes'
} else {
  try {
    $ngc = Join-Path $env:LOCALAPPDATA 'Microsoft\\Ngc'
    if (Test-Path -Path (Join-Path $ngc '*\\*.dat')) { $enrolled = 'yes' }
  } catch {
    $enrolled = 'no'
  }
}
"HELLO_ENROLLED:$enrolled"
`

/**
 * Ask the verifier what it can do here, without showing a prompt.
 *
 * This is the check that has to run *before* the screen is covered. A verifier
 * that cannot answer at all is cross-checked against the user's Hello container
 * — see `resolveHelloAvailability` — because the API failing is not the same as
 * the PIN not existing.
 */
export function checkWindowsHello(): Promise<HelloAvailability> {
  if (process.platform !== 'win32') return Promise.resolve('unavailable')
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: HelloAvailability): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELLO_AVAILABILITY_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      finish('unavailable')
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      finish('unavailable')
    }, 12_000)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish('unavailable')
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(resolveHelloAvailability(out))
    })
  })
}

const HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($operation))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $status = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:WARDEN_HELLO_REASON)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  "HELLO:$status"
} catch {
  "HELLO:Unavailable"
}
`

/** Map the child's single line of output to an outcome. Anything else fails. */
export function parseHelloResult(output: string): HelloOutcome {
  const match = /HELLO:([A-Za-z]+)/.exec(output)
  const value = (match?.[1] ?? '').toLowerCase()
  switch (value) {
    case 'verified':
      return 'verified'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    case 'notconfiguredforuser':
      return 'not-configured'
    case 'devicenotpresent':
      return 'not-present'
    case 'disabledbypolicy':
      return 'disabled'
    case 'devicebusy':
      return 'busy'
    case 'retriesexhausted':
      return 'retries-exhausted'
    default:
      return 'unavailable'
  }
}

/**
 * Ask Windows Hello to verify the signed-in user.
 *
 * The prompt is the operating system's own, so windows, taps and lockout
 * counting are handled by Windows rather than by WARDEN. Nothing is verified if
 * the child cannot run: an unavailable verifier never unlocks.
 */
export function promptWindowsHello(reason: string): Promise<HelloOutcome> {
  if (process.platform !== 'win32') return Promise.resolve('unavailable')
  const message = reason.slice(0, 120) || 'Unlock WARDEN'
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: HelloOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELLO_SCRIPT],
        {
          // The consent dialog is Windows' own window, not this console, so the
          // console stays hidden; WARDEN lowers its overlay while the prompt is
          // up so it cannot end up behind an always-on-top window.
          windowsHide: true,
          env: { ...process.env, WARDEN_HELLO_REASON: message },
          stdio: ['ignore', 'pipe', 'ignore']
        }
      )
    } catch {
      finish('unavailable')
      return
    }
    let out = ''
    // The operator has to touch the sensor or type the PIN, and Windows counts
    // its own retries, so the ceiling is generous rather than tight.
    const timer = setTimeout(() => {
      child.kill()
      finish('cancelled')
    }, 90_000)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish('unavailable')
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(parseHelloResult(out))
    })
  })
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WardenLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  public static bool Check(string user, string domain, string password) {
    IntPtr token;
    if (LogonUser(user, domain, password, 3, 0, out token)) { CloseHandle(token); return true; }
    return false;
  }
}
'@
$password = [Console]::In.ReadLine()
if ([string]::IsNullOrEmpty($password)) { 'FAIL'; exit 0 }
$candidates = $env:WARDEN_LOGON_CANDIDATES | ConvertFrom-Json
foreach ($entry in $candidates) {
  try {
    if ([WardenLogon]::Check($entry.user, $entry.domain, $password)) { 'OK'; exit 0 }
  } catch { }
}
'FAIL'
`

/** Account names to try: the local account, the domain account, and MSA email. */
function candidates(): { user: string; domain: string }[] {
  const user = os.userInfo().username
  const domain = process.env.USERDOMAIN || os.hostname()
  const list: { user: string; domain: string }[] = [
    { user, domain },
    { user, domain: '.' },
    { user, domain: '' }
  ]
  const upn = process.env.USERPRINCIPALNAME
  if (upn) list.push({ user: upn, domain: '' })
  if (user.includes('@')) list.push({ user, domain: '' })
  const seen = new Set<string>()
  return list.filter((entry) => {
    const key = `${entry.user}\\${entry.domain}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Resolves true only on a successful Windows logon. Any failure — no
 * PowerShell, a locked account, an unexpected exit — resolves false, so a
 * broken verifier can never unlock the screen.
 */
export function verifyWindowsPassword(password: string): Promise<boolean> {
  if (typeof password !== 'string' || !password) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
        {
          windowsHide: true,
          env: { ...process.env, WARDEN_LOGON_CANDIDATES: JSON.stringify(candidates()) },
          stdio: ['pipe', 'pipe', 'ignore']
        }
      )
    } catch {
      finish(false)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 15_000)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(/\bOK\b/.test(out))
    })
    child.stdin?.on('error', () => {
      /* the child may exit before reading; close handles the result */
    })
    child.stdin?.end(`${password}\n`)
  })
}
