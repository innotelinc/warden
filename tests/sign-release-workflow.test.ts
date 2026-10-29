import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The signed-release steps cannot run until SignPath is armed, so the build job
 * rehearses them against a self-signed copy of the installer it has just built.
 * That gate is worth exactly as much as its position in the job: moved after the
 * publish step, or softened with continue-on-error, it would go green while
 * unsigned installers reached the release page — the failure the signing path
 * exists to prevent. It is the only thing standing between a workflow regression
 * and a tag that ships it.
 *
 * Nothing here executes the workflow. It is checked as text, the way the mobile
 * workflows and the APK check are.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const lines = read('.github/workflows/sign-release.yml').split(/\r?\n/)

const BUILD = 'Build installers'
const GATE = 'Rehearse the signed-release path'
const PUBLISH = 'Publish the installers'

function stepStart(name: string): number {
  const index = lines.findIndex((line) => /^ {6}- name: /.test(line) && line.includes(name))
  if (index === -1) throw new Error(`the workflow has no step called "${name}"`)
  return index
}

/** A step from its `- name:` line up to the next step or the next job. */
function stepText(name: string): string {
  const start = stepStart(name)
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end] ?? ''
    if (/^ {6}- /.test(line) || /^ {0,4}\S/.test(line)) break
    end += 1
  }
  return lines.slice(start, end).join('\n')
}

describe('signed-release gate', () => {
  /**
   * A gate that runs after the upload has already happened proves the workflow
   * broken and publishes the release anyway, which is the one ordering that is
   * worse than not checking at all.
   */
  it('rehearses after the installers exist and before anything is published', () => {
    expect(stepStart(BUILD)).toBeLessThan(stepStart(GATE))
    expect(stepStart(GATE)).toBeLessThan(stepStart(PUBLISH))
  })

  /** A renamed script would make the step a no-op that still exits zero. */
  it('runs the rehearsal script the repository ships', () => {
    expect(stepText(GATE)).toContain('node scripts/rehearse-signing.mjs')
    expect(existsSync(fileURLToPath(new URL('../scripts/rehearse-signing.mjs', import.meta.url)))).toBe(true)
  })

  /**
   * The step runs under pwsh, and the Windows PowerShell child it starts would
   * inherit PowerShell 7's PSModulePath. Windows PowerShell then cannot find its
   * own modules, so it has no certificate provider: the first Cert:\ path fails
   * as DriveNotFoundException and the gate fails on a certificate error that is
   * really a module-path one. The first run of this gate failed exactly that way.
   */
  it('does not hand a PowerShell 7 module path to the signing shell', () => {
    expect(read('scripts/rehearse-signing.mjs')).toContain("unset: ['PSModulePath']")
  })

  /**
   * `throw` matters here: pwsh reports a native command's failure only as
   * $LASTEXITCODE, and a step that prints the result instead of raising exits 0
   * however many checks the rehearsal failed.
   */
  it('fails the job rather than recording the result', () => {
    const text = stepText(GATE)
    expect(text).not.toContain('continue-on-error')
    expect(text).toMatch(/\$LASTEXITCODE -ne 0/)
    expect(text).toContain('throw')
  })
})
