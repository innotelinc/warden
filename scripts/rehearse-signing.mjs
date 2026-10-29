#!/usr/bin/env node
/**
 * rehearse-signing.mjs — run the signed-release steps against a self-signed
 * installer, before SignPath is armed.
 *
 * The signing workflow cannot be exercised until an organization id and an API
 * token exist, and each attempt at it costs a full build plus a tag. Three
 * things in it are worth knowing before that: whether the signature check
 * catches what it is meant to, whether latest.yml ends up describing the bytes
 * that signed, and whether a re-run can still publish an unsigned installer.
 * None of them depends on who signed the file.
 *
 * So this rehearses them locally, with a self-signed certificate from
 * scripts/sign-build.ps1, and — this is the point — runs the *shipped* step text
 * out of .github/workflows/sign-release.yml rather than a copy of it. A copy
 * would pass while the workflow stayed broken.
 *
 * `gh` is replaced by a stub that keeps a fake release on disk, so the publish
 * step can be run twice: once as a first build, once as a re-run against an
 * already published release. The second is the one that matters — it is what a
 * tag moved onto a fix looks like.
 *
 * What this cannot prove, and does not claim to: that SignPath returns a valid,
 * timestamped signature. A self-signed certificate is always untrusted here, so
 * the signature check is expected to *reject* these files; the rehearsal asserts
 * that it does, and that the files carry a timestamp. The accepting branch is
 * SignPath's.
 *
 * Usage (needs a build: npm run dist:ci):
 *   node scripts/rehearse-signing.mjs
 *
 *   --installer <file>  the unsigned NSIS installer (default: newest release/WARDEN-Setup-*.exe)
 *   --latest <file>     its latest.yml (default: release/latest.yml)
 *   --workdir <dir>     scratch directory (default: a temp directory, kept on failure)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(ROOT, '.github', 'workflows', 'sign-release.yml')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

/** One line per claim, printed at the end; non-zero exit if any failed. */
const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    windowsHide: true
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const powershell = (script, env = {}, cwd = ROOT) =>
  run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd,
    env
  })

/**
 * Pull a step's `run:` block out of the workflow by its name.
 *
 * Deliberately text-based and strict: if the workflow is reformatted so this
 * cannot find the step, the rehearsal fails instead of quietly testing nothing.
 */
function stepRun(workflow, stepName) {
  const lines = readFileSync(workflow, 'utf8').split(/\r?\n/)
  const start = lines.findIndex(
    (line) => /^ {6}- name:/.test(line) && line.includes(stepName)
  )
  if (start === -1) throw new Error(`workflow has no step named "${stepName}"`)

  let i = start + 1
  while (i < lines.length && !/^\s*run: \|/.test(lines[i])) {
    if (/^ {6}- name:/.test(lines[i])) throw new Error(`step "${stepName}" has no run block`)
    i += 1
  }
  if (i === lines.length) throw new Error(`step "${stepName}" has no run block`)

  const body = []
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (!/^ {10}/.test(line)) break
    body.push(line.slice(10))
  }
  while (body.length && body[body.length - 1] === '') body.pop()
  return body.join('\n')
}

/**
 * A `gh` that changes a fake release on disk instead of talking to GitHub.
 *
 * The publish and metadata steps call gh for exactly five things, so the stub
 * implements those five and records every call. `LASTEXITCODE` is set the way
 * the real CLI sets it, because the steps branch on it.
 */
const GH_STUB = String.raw`
$ErrorActionPreference = 'Stop'
function gh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  Add-Content -LiteralPath $env:REHEARSE_LOG -Value ($Arguments -join ' ')
  $state = $env:REHEARSE_RELEASE
  $assets = $env:REHEARSE_ASSETS
  switch ($Arguments[1]) {
    'view' {
      if (-not (Test-Path -LiteralPath $state)) { $global:LASTEXITCODE = 1; return }
      $global:LASTEXITCODE = 0
      if ($Arguments -contains '--json') {
        Get-ChildItem -LiteralPath $assets -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
      }
    }
    'create' {
      $body = if ($Arguments -contains '--draft') { 'draft' } else { 'published' }
      Set-Content -LiteralPath $state -Value $body -NoNewline
      $global:LASTEXITCODE = 0
    }
    'edit' {
      Set-Content -LiteralPath $state -Value 'draft' -NoNewline
      $global:LASTEXITCODE = 0
    }
    'upload' {
      foreach ($path in ($Arguments | Where-Object { $_ -notlike '-*' -and $_ -ne 'release' -and $_ -ne $env:REHEARSE_TAG })) {
        Get-ChildItem -Path $path -File -ErrorAction SilentlyContinue | ForEach-Object {
          Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $assets $_.Name) -Force
        }
      }
      $global:LASTEXITCODE = 0
    }
    'download' {
      $dir = $env:REHEARSE_DIR
      if ($Arguments -contains '--dir') { $dir = $Arguments[[array]::IndexOf($Arguments, '--dir') + 1] }
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $pattern = $Arguments[[array]::IndexOf($Arguments, '--pattern') + 1]
      $found = Get-ChildItem -LiteralPath $assets -Filter $pattern -File -ErrorAction SilentlyContinue
      foreach ($file in $found) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dir $file.Name) -Force }
      $global:LASTEXITCODE = if ($found) { 0 } else { 1 }
    }
    'delete-asset' {
      $name = $Arguments[3]
      Remove-Item -LiteralPath (Join-Path $assets $name) -Force -ErrorAction SilentlyContinue
      $global:LASTEXITCODE = 0
    }
    default { $global:LASTEXITCODE = 0 }
  }
}
`

/** Run a shipped step's text in a scratch directory, with gh stubbed. */
function runStep({ name, workdir, text, env, cwd = workdir }) {
  const script = join(workdir, `step-${name.replace(/\W+/g, '-').toLowerCase()}.ps1`)
  writeFileSync(script, `${GH_STUB}\n${text}\n`, 'utf8')
  return powershell(`& '${script.replace(/'/g, "''")}'`, env, cwd)
}

function main() {
  const installer =
    flag('installer', null) ??
    (() => {
      const dir = join(ROOT, 'release')
      if (!existsSync(dir)) return null
      const found = readdirSync(dir)
        .filter((f) => /^WARDEN-Setup-.*\.exe$/.test(f))
        .sort()
      return found.length ? join(dir, found[found.length - 1]) : null
    })()
  const latest = flag('latest', join(ROOT, 'release', 'latest.yml'))

  if (!installer || !existsSync(installer)) {
    process.stderr.write(
      'no installer to rehearse with. Build one first: npm run dist:ci\n' +
        '(the rehearsal signs a real 130 MB installer rather than a stand-in, because\n' +
        "a stand-in would not carry the version resource SignPath's metadata constraint\n" +
        'checks, and latest.yml has to describe the file that is really shipped)\n'
    )
    process.exit(2)
  }
  if (!existsSync(latest)) {
    process.stderr.write(`no ${latest} — the build writes it next to the installers\n`)
    process.exit(2)
  }

  const workdir = flag('workdir', null) ?? mkdtempSync(join(tmpdir(), 'warden-sign-rehearsal-'))
  mkdirSync(workdir, { recursive: true })
  const signedDir = join(workdir, 'signed')
  const assetsDir = join(workdir, 'assets')
  mkdirSync(signedDir, { recursive: true })
  mkdirSync(assetsDir, { recursive: true })

  const unsignedBytes = readFileSync(installer)
  const unsignedHash = createHash('sha512').update(unsignedBytes).digest('base64')
  const name = basename(installer)

  // 1. Sign a copy with the repository's own tooling.
  const copy = join(signedDir, name)
  copyFileSync(installer, copy)
  const sign = powershell(
    `& '${join(ROOT, 'scripts', 'sign-build.ps1').replace(/'/g, "''")}' ` +
      `-Subject 'CN=WARDEN rehearsal, O=innotelinc, C=US' ` +
      `-Files '${copy.replace(/'/g, "''")}' -CertDir '${join(workdir, 'cert').replace(/'/g, "''")}'`
  )
  if (sign.code !== 0) {
    record('signing a copy', false, sign.out.trim().split('\n').slice(-3).join(' | '))
    return finish(workdir)
  }
  const signedBytes = readFileSync(copy)
  record(
    'signing changed the bytes latest.yml describes',
    createHash('sha512').update(signedBytes).digest('base64') !== unsignedHash,
    `${unsignedBytes.length} → ${signedBytes.length} bytes`
  )

  // 2. The shipped signature check must reject an untrusted signature, and the
  //    files must carry a timestamp — an untimestamped signature stops being
  //    verifiable when the certificate expires.
  const status = powershell(
    `$s = Get-AuthenticodeSignature -FilePath '${copy.replace(/'/g, "''")}';` +
      `[pscustomobject]@{` +
      `Status = [string]$s.Status;` +
      `Subject = [string]$s.SignerCertificate.Subject;` +
      `Timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress`
  )
  let info = {}
  try {
    info = JSON.parse(status.out.trim().split(/\r?\n/).pop())
  } catch {
    record('read the signature back', false, status.out.trim().slice(0, 200))
  }
  record(
    'the installer carries a signature and a timestamp',
    Boolean(info.Subject) && info.Timestamped === true,
    `${info.Status ?? '?'} · ${info.Subject ?? 'no signer'} · ${info.Timestamped ? 'timestamped' : 'NOT timestamped'}`
  )

  const checkText = stepRun(WORKFLOW, 'Check the signatures')
  const check = runStep({
    name: 'Check the signatures',
    workdir,
    text: checkText,
    env: { REHEARSE_LOG: join(workdir, 'gh.log'), REHEARSE_ASSETS: assetsDir, REHEARSE_RELEASE: join(workdir, 'release-state'), REHEARSE_TAG: 'v0.0.0', REHEARSE_DIR: workdir }
  })
  record(
    'the signature check refuses an untrusted signer',
    check.code !== 0 && /not validly signed and timestamped/.test(check.out),
    check.code !== 0 ? 'rejected, as a self-signed certificate must be' : 'ACCEPTED an untrusted installer'
  )

  // 3. The metadata step, against the signed bytes.
  mkdirSync(join(workdir, 'scripts'), { recursive: true })
  copyFileSync(join(ROOT, 'scripts', 'refresh-update-metadata.mjs'), join(workdir, 'scripts', 'refresh-update-metadata.mjs'))
  copyFileSync(latest, join(assetsDir, 'latest.yml'))
  // The unsigned build's artifacts, as the build job would have left them.
  for (const file of readdirSync(join(ROOT, 'release'))) {
    if (file.endsWith('.blockmap')) copyFileSync(join(ROOT, 'release', file), join(assetsDir, file))
  }
  const state = join(workdir, 'release-state')
  writeFileSync(state, 'draft')

  const log = join(workdir, 'gh.log')
  writeFileSync(log, '')
  const meta = runStep({
    name: 'Refresh the update metadata',
    workdir,
    text: stepRun(WORKFLOW, 'Refresh the update metadata'),
    env: {
      GH_TOKEN: 'rehearsal',
      TAG: 'v0.0.0',
      REHEARSE_LOG: log,
      REHEARSE_ASSETS: assetsDir,
      REHEARSE_RELEASE: state,
      REHEARSE_TAG: 'v0.0.0',
      REHEARSE_DIR: join(workdir, 'meta')
    }
  })

  const refreshed = join(assetsDir, 'latest.yml')
  const manifest = existsSync(refreshed) ? readFileSync(refreshed, 'utf8') : ''
  const recordedHash = /^sha512: (\S+)$/m.exec(manifest)?.[1] ?? ''
  const recordedSize = Number(/^ {4}size: (\d+)$/m.exec(manifest)?.[1] ?? 0)
  const signedHash = createHash('sha512').update(signedBytes).digest('base64')

  record('the metadata step ran', meta.code === 0, meta.code === 0 ? 'ok' : meta.out.trim().split('\n').slice(-3).join(' | '))
  record(
    'latest.yml now describes the signed installer',
    recordedHash === signedHash && recordedSize === signedBytes.length,
    `${recordedHash.slice(0, 16)}… / ${recordedSize} bytes (unsigned was ${unsignedHash.slice(0, 16)}… / ${unsignedBytes.length})`
  )
  const blockmaps = readdirSync(assetsDir).filter((f) => f.endsWith('.blockmap'))
  record(
    'the stale differential maps are gone',
    blockmaps.length === 0,
    blockmaps.length ? `still present: ${blockmaps.join(', ')}` : 'removed'
  )

  // 4. The publish step, twice: a first build, then a re-run.
  const publishText = stepRun(WORKFLOW, 'Publish the installers')
  const publishEnv = (releaseState) => {
    writeFileSync(log, '')
    if (releaseState === null) rmSync(state, { force: true })
    else writeFileSync(state, releaseState)
    return {
      GH_TOKEN: 'rehearsal',
      TAG: 'v0.2.19',
      SIGNPATH: 'organization-id',
      REHEARSE_LOG: log,
      REHEARSE_ASSETS: assetsDir,
      REHEARSE_RELEASE: state,
      REHEARSE_TAG: 'v0.2.19',
      REHEARSE_DIR: workdir
    }
  }

  // The publish step globs the build output, so it runs where the build left it.
  const first = runStep({ name: 'publish-first', workdir, text: publishText, env: publishEnv(null), cwd: ROOT })
  const firstCalls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  record(
    'a first build creates a draft',
    first.code === 0 && firstCalls.some((c) => /^release create .*--draft/.test(c)),
    firstCalls.find((c) => c.startsWith('release create')) ?? first.out.trim().slice(-160)
  )

  const rerun = runStep({ name: 'publish-rerun', workdir, text: publishText, env: publishEnv('published'), cwd: ROOT })
  const rerunCalls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  const draftIndex = rerunCalls.findIndex((c) => /^release edit .*--draft/.test(c))
  const uploadIndex = rerunCalls.findIndex((c) => c.startsWith('release upload'))
  record(
    'a re-run returns a published release to draft before uploading',
    rerun.code === 0 && draftIndex !== -1 && uploadIndex !== -1 && draftIndex < uploadIndex,
    draftIndex === -1
      ? 'uploaded unsigned installers over a published release'
      : `${rerunCalls.length} gh call(s), draft before upload`
  )
  record(
    'the release is left as a draft for the sign job',
    readFileSync(state, 'utf8').trim() === 'draft',
    `state: ${readFileSync(state, 'utf8').trim()}`
  )

  return finish(workdir)
}

function finish(workdir) {
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}\n`)
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(
    `\n${results.length - failed}/${results.length} checks passed · scratch: ${workdir}\n`
  )
  if (failed) {
    process.stdout.write('The scratch directory is kept so the scripts and logs can be read.\n')
    process.exitCode = 1
  } else {
    rmSync(workdir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`rehearse-signing: ${error.message}\n`)
  process.exit(1)
}
