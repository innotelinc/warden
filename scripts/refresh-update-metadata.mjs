#!/usr/bin/env node
/**
 * refresh-update-metadata.mjs — describe the bytes that actually shipped.
 *
 * electron-builder writes latest.yml while it builds, so every hash in it is
 * taken from the installer before it is signed. Signing rewrites the installer:
 * a different byte count, a different SHA-512, and an appended signature. An
 * installed WARDEN reads latest.yml, downloads `files[0].url`, hashes it and
 * compares — against the unsigned bytes it will never see again. The update is
 * refused, every time, and the failure looks like a corrupt download rather than
 * a stale manifest.
 *
 * The block map has the same problem one level down: it indexes the unsigned
 * file in 4 KiB chunks, so a differential update assembled from it produces a
 * file that fails its own checksum halfway through. There is no correct way to
 * patch an unsigned block map, so the signed release ships without one and
 * clients download the whole installer.
 *
 * This script re-derives the manifest from the signed installer. It keeps the
 * version and release date the build recorded — those describe the release, not
 * the bytes — and replaces the name, size and hash with the ones the file now
 * has.
 *
 * Usage (see .github/workflows/sign-release.yml):
 *   node scripts/refresh-update-metadata.mjs \
 *     --latest meta/latest.yml --exe signed/WARDEN-Setup-0.2.18.exe --out meta/latest.yml
 *
 *   --latest <file>   the latest.yml electron-builder wrote (required)
 *   --exe <file>      the signed installer that will be served (required)
 *   --out <file>      where to write; defaults to overwriting --latest
 *   --date <iso>      release date to record; defaults to the one in --latest
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/** electron-updater compares a base64 SHA-512, not a hex digest. */
export function sha512Of(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

/**
 * Rewrite an electron-builder latest.yml for a different file.
 *
 * Only the fields that describe the file are replaced. The rest of the manifest
 * is regenerated in electron-builder's own shape — version, one files entry,
 * path and sha512 repeated for older updaters, releaseDate — because a partial
 * edit of the text would leave a stray size or block map field describing the
 * old bytes, which is the failure this exists to prevent.
 */
export function refreshLatestYml(latest, { url, size, sha512, releaseDate }) {
  const version = /^version:[ \t]*(\S+)[ \t]*$/m.exec(latest)?.[1]
  if (!version) throw new Error('latest.yml has no version line')

  const recorded =
    releaseDate ?? /^releaseDate:[ \t]*['"]?([^'"\r\n]+?)['"]?[ \t]*$/m.exec(latest)?.[1]
  const date = recorded ?? new Date().toISOString()

  for (const [name, value] of Object.entries({ url, sha512 })) {
    if (!value) throw new Error(`refusing to write latest.yml without ${name}`)
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`refusing to write latest.yml with size ${size}`)
  }

  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${date}'`,
    ''
  ].join('\n')
}

export function metadataFor(path) {
  const bytes = readFileSync(path)
  return { url: basename(path), size: bytes.length, sha512: sha512Of(bytes) }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.latest || !args.exe) {
    throw new Error('usage: refresh-update-metadata.mjs --latest <latest.yml> --exe <installer.exe> [--out <file>]')
  }

  const before = readFileSync(args.latest, 'utf8')
  const now = metadataFor(args.exe)
  const after = refreshLatestYml(before, { ...now, releaseDate: args.date })
  const out = args.out ?? args.latest
  writeFileSync(out, after)

  const was = /^[ \t]*sha512:[ \t]*(\S+)[ \t]*$/m.exec(before)?.[1] ?? '(none)'
  process.stdout.write(
    `${out}: ${now.url} ${now.size} bytes sha512 ${now.sha512.slice(0, 16)}… ` +
      `(was ${was.slice(0, 16)}…)\n`
  )
  if (was === now.sha512) {
    process.stdout.write('warning: the hash did not change — the installer was not modified\n')
  }
}

// pathToFileURL, not string surgery: on Windows argv[1] is a drive path and a
// comparison against import.meta.url would never match, so the CLI would exit
// silently having done nothing — on the step that exists to fix the hashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`refresh-update-metadata: ${error.message}\n`)
    process.exit(1)
  }
}
