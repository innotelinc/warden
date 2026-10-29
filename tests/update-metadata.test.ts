import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Signing an installer changes its bytes, and latest.yml is written before that
 * happens. The manifest the updater reads therefore describes a file that is
 * never served: electron-updater downloads the signed exe, compares its SHA-512
 * with the recorded one and refuses the update — as a corrupt download, which is
 * the wrong place to go looking for the bug.
 *
 * The tests below are about that manifest being derived from what shipped. The
 * hash is checked against an independent computation rather than against the
 * script's own helper, because a manifest that agrees with itself and nothing
 * else passes trivially and breaks every client.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/refresh-update-metadata.mjs', import.meta.url))

const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64')

/** electron-builder's own output for a 0.2.18 build, before signing. */
const UNSIGNED_MANIFEST = [
  'version: 0.2.18',
  'files:',
  '  - url: WARDEN-Setup-0.2.18.exe',
  '    sha512: JaF4gUFxlYFYrtzORmEPb/48ViCoGj0KpaST4g2UyRNo+yjXT5Y8xVH1svSQ2q5xFt/pZqIbGADKVCvjkdodxA==',
  '    size: 127675715',
  'path: WARDEN-Setup-0.2.18.exe',
  'sha512: JaF4gUFxlYFYrtzORmEPb/48ViCoGj0KpaST4g2UyRNo+yjXT5Y8xVH1svSQ2q5xFt/pZqIbGADKVCvjkdodxA==',
  "releaseDate: '2026-10-29T07:44:49.365Z'",
  ''
].join('\n')

function fixture(installer: Buffer, manifest = UNSIGNED_MANIFEST) {
  const dir = mkdtempSync(join(tmpdir(), 'warden-manifest-'))
  const latest = join(dir, 'latest.yml')
  const exe = join(dir, 'WARDEN-Setup-0.2.18.exe')
  writeFileSync(latest, manifest)
  writeFileSync(exe, installer)
  return { dir, latest, exe }
}

const run = (args: string[]): string =>
  execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

describe('latest.yml after signing', () => {
  it('describes the signed installer, not the one that was built', () => {
    // A signature makes the file longer and changes every hash of it.
    const signed = Buffer.concat([Buffer.from('unsigned installer bytes'), Buffer.from('~signed~')])
    const { latest, exe } = fixture(signed)

    run(['--latest', latest, '--exe', exe, '--out', latest])
    const manifest = readFileSync(latest, 'utf8')

    expect(manifest).toContain(`sha512: ${sha512(signed)}`)
    expect(manifest).toContain(`size: ${signed.length}`)
    // Both the files entry and the duplicate top-level pair, which older
    // updaters read instead of `files`.
    expect(manifest.match(new RegExp(`sha512: ${sha512(signed).replace(/[+/=]/g, '\\$&')}`, 'g'))).toHaveLength(2)
    expect(manifest).not.toContain('JaF4gUFxlYFYrtzORmEPb')
    expect(manifest).not.toContain('127675715')
  })

  it('keeps the version and release date the release was built with', () => {
    const { latest, exe } = fixture(Buffer.from('signed'))
    run(['--latest', latest, '--exe', exe, '--out', latest])
    const manifest = readFileSync(latest, 'utf8')

    expect(manifest).toContain('version: 0.2.18')
    expect(manifest).toContain("releaseDate: '2026-10-29T07:44:49.365Z'")
  })

  it('names the file the release actually serves', () => {
    const { latest, exe } = fixture(Buffer.from('signed'))
    run(['--latest', latest, '--exe', exe, '--out', latest])
    const manifest = readFileSync(latest, 'utf8')

    expect(manifest).toContain('  - url: WARDEN-Setup-0.2.18.exe')
    expect(manifest).toContain('path: WARDEN-Setup-0.2.18.exe')
  })

  it('refuses a manifest with no version instead of writing half of one', () => {
    const { latest, exe } = fixture(Buffer.from('signed'), "releaseDate: '2026-10-29T07:44:49.365Z'\n")

    expect(() => run(['--latest', latest, '--exe', exe, '--out', latest])).toThrow(/no version line/)
    expect(readFileSync(latest, 'utf8')).not.toContain('sha512')
  })

  it('fails when the installer it was pointed at is not there', () => {
    const { latest, dir } = fixture(Buffer.from('signed'))
    expect(() => run(['--latest', latest, '--exe', join(dir, 'missing.exe'), '--out', latest])).toThrow()
  })
})
