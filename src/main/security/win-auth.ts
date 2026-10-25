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
