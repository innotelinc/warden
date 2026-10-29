#!/usr/bin/env node
/**
 * landing-release-json.mjs — describe the release the landing page advertises,
 * as a file the site serves from its own origin.
 *
 * The page used to ask api.github.com which release was newest. That endpoint
 * allows 60 unauthenticated requests an hour, counted per address, so an office
 * behind one NAT could spend the budget by reloading and the captions would go
 * blank. A file in the deployed site costs nothing per visit, cannot be rate
 * limited, and is written by the pipeline that publishes the release rather
 * than by a browser.
 *
 * Which release: the newest published one that actually carries every artifact
 * the page links — the NSIS installer, the portable exe and
 * `WARDEN-android.apk` — with asset names that agree with its tag. That rule is
 * the whole point of the file. A release becomes visible on the release page
 * seconds after it is created, while its assets arrive minutes later from two
 * different workflows, so "latest" and "complete" are not the same release for
 * a few minutes. Choosing only complete releases means the page links a version
 * whose installer and APK both exist, and it self-corrects the moment the APK
 * lands: the next deploy of this manifest picks the new tag up.
 *
 * Usage (see .github/workflows/pages.yml):
 *   node scripts/landing-release-json.mjs --out web/landing/release.json
 *
 *   --input <file>   read a release list from disk instead of the API (tests,
 *                    and reproducing a decision without spending a request)
 *   --out <file>     where to write; defaults to web/landing/release.json
 *
 * Exits non-zero when no complete release is found, and in that case writes
 * nothing: the copy already on disk stays, so a stale-but-real release keeps
 * being advertised instead of the file being emptied.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const REPO = 'innotelinc/warden'
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`
const DEFAULT_OUT = 'web/landing/release.json'

/** A tag this project would ever publish: v1.2.3, nothing else. */
const TAG = /^v\d+\.\d+\.\d+$/

/**
 * The asset names the release job and the mobile job produce. The capture is
 * the version the artifact itself claims, which has to match the tag: a tag
 * left on an older installer is exactly the mixed release this file exists to
 * keep off the page.
 */
const SETUP = /^WARDEN-Setup-(.+)\.exe$/
const PORTABLE = /^WARDEN-Portable-(.+)\.exe$/
const APK = /^WARDEN-android\.apk$/

const versionOf = (tag) => tag.replace(/^v/, '')

/**
 * The manifest for one release, or null when the release cannot be linked to
 * as a whole. Nothing here trusts a field to exist; a release shaped
 * differently is skipped rather than turned into half a manifest.
 */
export function manifestFor(release) {
  if (!release || release.draft || release.prerelease) return null
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!TAG.test(tag)) return null
  if (!release.published_at) return null
  const assets = Array.isArray(release.assets) ? release.assets : []

  const version = versionOf(tag)
  const find = (pattern, whole = false) => {
    for (const asset of assets) {
      if (typeof asset?.name !== 'string' || typeof asset?.browser_download_url !== 'string') {
        continue
      }
      const match = pattern.exec(asset.name)
      if (!match) continue
      if (!whole && match[1] !== version) continue
      return asset
    }
    return null
  }

  const setup = find(SETUP)
  const portable = find(PORTABLE)
  const apk = find(APK, true)
  if (!setup || !portable || !apk) return null

  return {
    version,
    tag,
    publishedAt: release.published_at,
    page: `https://github.com/${REPO}/releases/tag/${tag}`,
    windows: {
      installer: setup.browser_download_url,
      portable: portable.browser_download_url,
    },
    android: {
      apk: apk.browser_download_url,
      bytes: typeof apk.size === 'number' ? apk.size : 0,
    },
  }
}

/** The newest complete release in an API listing, or null. */
export function pickRelease(releases) {
  const manifests = (Array.isArray(releases) ? releases : [])
    .map(manifestFor)
    .filter((manifest) => manifest !== null)
  if (manifests.length === 0) return null
  manifests.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return manifests[0] ?? null
}

async function fetchReleases() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const res = await fetch(API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'warden-landing-manifest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`release list: ${res.status} ${res.statusText}`)
  return res.json()
}

const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

async function main() {
  const out = arg('out', DEFAULT_OUT)
  const input = arg('input')

  const releases = input ? JSON.parse(readFileSync(input, 'utf8')) : await fetchReleases()
  const manifest = pickRelease(releases)

  if (!manifest) {
    const seen = Array.isArray(releases) ? releases.length : 0
    console.error(
      `no complete release in ${seen} listing(s); leaving ${out} as it is so the page keeps ` +
        'advertising the last release that had every artifact'
    )
    process.exit(1)
  }

  // Compare before writing, so a redeploy that decides the same thing says so
  // instead of looking like a change.
  let previous = ''
  try {
    previous = readFileSync(out, 'utf8')
  } catch {
    // First run: nothing to compare with.
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  if (previous === text) {
    console.log(`release.json unchanged: ${manifest.tag} · ${manifest.publishedAt}`)
    return
  }
  writeFileSync(out, text)
  console.log(
    `release.json: ${manifest.tag} · ${manifest.publishedAt} · ` +
      `apk ${manifest.android.bytes} bytes`
  )
}

// Importable for tests without running the CLI; the CLI runs when executed.
// pathToFileURL, not string surgery: on Windows argv[1] is a drive path and a
// hand-built file:// URL silently never matches, which ran nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release.json not written: ${error.message}`)
    process.exit(1)
  })
}
