import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The landing page prints a version and pins both download buttons to one tag,
 * and it gets that from a file this site serves rather than from the GitHub API.
 *
 * The interesting part is which release that file names. A release appears on
 * the release page as soon as the desktop job creates it; the APK is attached
 * minutes later by a different workflow. In between, `releases/latest` is a tag
 * whose APK does not exist, and a page that simply believed "latest" would send
 * a phone to a 404 or to a build from an older tag. So the generator is tested
 * on exactly that shape of data, and on the failure that must not empty the
 * deployed copy.
 */

const file = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url))
const read = (relative: string): string => readFileSync(file(relative), 'utf8')

const SCRIPT = file('scripts/landing-release-json.mjs')
const MANIFEST = 'web/landing/release.json'

interface Asset {
  name: string
  size: number
  browser_download_url: string
}

interface Release {
  tag_name: string
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: Asset[]
}

const release = (
  tag: string,
  published: string,
  assets: string[] = ['setup', 'portable', 'apk'],
  extra: { draft?: boolean; prerelease?: boolean } = {}
): Release => {
  const version = tag.replace(/^v/, '')
  const names: Record<string, string> = {
    setup: `WARDEN-Setup-${version}.exe`,
    portable: `WARDEN-Portable-${version}.exe`,
    apk: 'WARDEN-android.apk',
  }
  return {
    tag_name: tag,
    published_at: published,
    draft: extra.draft ?? false,
    prerelease: extra.prerelease ?? false,
    assets: assets.map((key) => {
      const name = names[key] ?? key
      return {
        name,
        size: 1024,
        browser_download_url: `https://github.com/innotelinc/warden/releases/download/${tag}/${name}`,
      }
    }),
  }
}

/** Run the generator the way the deploy does, and report its exit status. */
const runCli = (...args: string[]): number => {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' })
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? 1
  }
}

/** Put a release listing where the generator expects a fixture, then run it. */
const withFixture = (releases: Release[], ...args: string[]): number => {
  const dir = mkdtempSync(join(tmpdir(), 'warden-landing-'))
  const input = join(dir, 'releases.json')
  writeFileSync(input, JSON.stringify(releases))
  return runCli('--input', input, ...args)
}

const generate = (releases: Release[], out: string): number =>
  withFixture(releases, '--out', out)

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'warden-out-')), 'release.json')

describe('the release the landing page advertises', () => {
  /**
   * The half-published release is the case that matters: it exists, it is
   * published, and its APK does not exist yet. The page has to fall back to the
   * older release that a phone can actually install all of.
   */
  it('takes the newest release that has every asset, not the newest tag', () => {
    const out = scratch()
    const status = generate(
      [
        release('v0.2.11', '2026-10-28T07:21:02Z', ['setup', 'portable']),
        release('v0.2.10', '2026-10-27T09:00:00Z'),
      ],
      out
    )
    expect(status).toBe(0)
    const manifest = JSON.parse(readFileSync(out, 'utf8'))
    expect(manifest.tag).toBe('v0.2.10')
    expect(manifest.version).toBe('0.2.10')
    expect(manifest.publishedAt).toBe('2026-10-27T09:00:00Z')
  })

  it('pins both downloads and the page to that one tag', () => {
    const out = scratch()
    generate([release('v0.2.15', '2026-10-29T03:53:39Z')], out)
    const manifest = JSON.parse(readFileSync(out, 'utf8'))
    const pinned = 'https://github.com/innotelinc/warden/releases/download/v0.2.15/'
    expect(manifest.windows.installer).toBe(`${pinned}WARDEN-Setup-0.2.15.exe`)
    expect(manifest.windows.portable).toBe(`${pinned}WARDEN-Portable-0.2.15.exe`)
    expect(manifest.android.apk).toBe(`${pinned}WARDEN-android.apk`)
    expect(manifest.page).toBe('https://github.com/innotelinc/warden/releases/tag/v0.2.15')
  })

  it('skips drafts and prereleases', () => {
    const out = scratch()
    const status = generate(
      [
        release('v0.2.20', '2026-10-30T00:00:00Z', undefined, { draft: true }),
        release('v0.2.19', '2026-10-29T20:00:00Z', undefined, { prerelease: true }),
        release('v0.2.18', '2026-10-29T10:00:00Z'),
      ],
      out
    )
    expect(status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).tag).toBe('v0.2.18')
  })

  /**
   * A tag left pointing at an older build — the shape of a mistaken re-tag.
   * Linking it would hand a visitor 0.1.9 under a page that says 0.2.0.
   */
  it('skips a release whose artifacts disagree with its tag', () => {
    const out = scratch()
    const status = generate(
      [
        release('v0.2.0', '2026-10-29T10:00:00Z', [
          'WARDEN-Setup-0.1.9.exe',
          'WARDEN-Portable-0.1.9.exe',
          'apk',
        ]),
        release('v0.1.9', '2026-10-28T10:00:00Z'),
      ],
      out
    )
    expect(status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).tag).toBe('v0.1.9')
  })

  /**
   * The deployed copy is the fallback. A run that cannot find a complete release
   * must fail loudly and touch nothing: truncating it would leave the page with
   * no version at all, which is worse than one release behind.
   */
  it('leaves the deployed copy untouched when nothing is complete', () => {
    const out = scratch()
    writeFileSync(out, '{"tag":"v0.2.15"}\n')
    const status = generate([release('v0.2.20', '2026-10-30T00:00:00Z', ['setup'])], out)
    expect(status).not.toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('{"tag":"v0.2.15"}\n')
  })
})

/**
 * The scheduled check is the only thing that can notice the committed fallback
 * went stale: every other check compares the file with itself. Its three exit
 * codes are the whole contract, so they are tested rather than assumed.
 */
describe('the staleness check', () => {
  it('passes when the file already names the newest complete release', () => {
    const out = scratch()
    generate([release('v0.2.15', '2026-10-29T03:53:39Z')], out)
    expect(withFixture([release('v0.2.15', '2026-10-29T03:53:39Z')], '--check', '--out', out)).toBe(0)
  })

  it('fails when a newer complete release exists', () => {
    const out = scratch()
    generate([release('v0.2.13', '2026-10-29T03:13:21Z')], out)
    const status = withFixture(
      [
        release('v0.2.16', '2026-10-30T09:00:00Z'),
        release('v0.2.13', '2026-10-29T03:13:21Z'),
      ],
      '--check',
      '--out',
      out
    )
    expect(status).toBe(1)
    // A finding, not a repair: the check never writes.
    expect(JSON.parse(readFileSync(out, 'utf8')).tag).toBe('v0.2.13')
  })

  it('reports an unreadable release list separately from a stale file', () => {
    // 2, not 1: the scheduled workflow warns on this and fails on 1, because a
    // GitHub wobble is not a stale site.
    expect(runCli('--check', '--input', join(tmpdir(), 'no-such-listing.json'))).toBe(2)
  })
})

describe('the committed manifest', () => {
  /**
   * This file is what gets deployed when the API cannot be reached, so it has to
   * describe one real release with nothing half-filled.
   */
  it('names one release, and every link belongs to its tag', () => {
    const manifest = JSON.parse(read(MANIFEST))
    expect(manifest.tag).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(manifest.version).toBe(String(manifest.tag).replace(/^v/, ''))
    expect(Number.isNaN(Date.parse(manifest.publishedAt))).toBe(false)
    expect(manifest.page).toContain(`/releases/tag/${manifest.tag}`)
    for (const url of [
      manifest.windows.installer,
      manifest.windows.portable,
      manifest.android.apk,
    ]) {
      expect(url).toContain(`/releases/download/${manifest.tag}/`)
      expect(url).toContain(manifest.version)
    }
  })
})

describe('the landing page and its deploy', () => {
  const page = read('web/landing/index.html')

  it('reads the manifest instead of calling the API from the browser', () => {
    expect(page).toContain("fetch('release.json'")
    expect(page).not.toContain('api.github.com')
  })

  it('gives both downloads a hook the manifest can retarget', () => {
    expect(page).toContain('data-download="windows"')
    expect(page).toContain('data-download="android"')
    // The card prints the URL, so that copy has to move with the button.
    expect(page).toContain('data-download-path')
    // And with no manifest at all, the rolling link is still a working download.
    expect(page).toContain('releases/latest/download/WARDEN-android.apk')
  })

  /**
   * Regeneration has to be triggered by the runs that attach the assets, not by
   * the tag push: at tag time the release does not exist, so the deploy would
   * keep describing the previous one until someone happened to push again.
   */
  it('regenerates the manifest when a release job finishes', () => {
    const workflow = read('.github/workflows/pages.yml')
    expect(workflow).toContain('scripts/landing-release-json.mjs')
    expect(workflow).toContain('workflow_run:')
    expect(workflow).toContain('Build and sign release')
    expect(workflow).toContain('Mobile (Android)')
    expect(workflow).toContain(`github.event.workflow_run.conclusion == 'success'`)
  })

  /**
   * The code a phone scans is drawn from the manifest, so it names the tag the
   * buttons are pinned to. Without that, the page could advertise 0.2.15 in its
   * caption and hand the phone 0.2.16 through the image — one page, two releases.
   */
  it('draws the QR from the manifest, so both name one tag', () => {
    expect(read('.github/workflows/pages.yml')).toContain('scripts/landing-qr.py')

    const manifest = JSON.parse(read(MANIFEST))
    const svg = read('web/landing/android-apk-qr.svg')
    const desc = /<desc>(.*?)<\/desc>/s.exec(svg)?.[1]?.trim()
    expect(desc).toBe(manifest.android.apk)
    expect(desc).toContain(`/download/${manifest.tag}/`)
  })

  /**
   * The image has to be *decoded*, not taken at its word: `<desc>` is a label the
   * generator writes, so an image whose modules are wrong carries an honest
   * label and still scans to nothing. CI installs a decoder and reads the pixels.
   */
  it('decodes the QR in CI instead of trusting its label', () => {
    const workflow = read('.github/workflows/ci.yml')
    expect(workflow).toContain('scripts/verify-qr.py')
    expect(workflow).toContain('opencv-python-headless')
    expect(read('scripts/verify-qr.py')).toContain('QRCodeDetector')
  })

  /**
   * The image is only correct against the manifest it was drawn from. If the
   * drawing fails the deploy has to fall back to the pair committed together,
   * not to a new manifest beside an old image.
   */
  it('keeps the image and the manifest a pair when drawing fails', () => {
    const workflow = read('.github/workflows/pages.yml')
    expect(workflow).toContain('git checkout -- web/landing/release.json')
    // segno comes from a venv, because the runner's Python is externally managed.
    expect(workflow).toContain('install --quiet segno')
  })

  it('checks the committed fallback on a schedule', () => {
    const workflow = read('.github/workflows/release-manifest.yml')
    expect(workflow).toContain('cron:')
    expect(workflow).toContain('--check')
    // The unreadable case must warn and pass; only drift fails the run.
    expect(workflow).toContain('the release list could not be read')
    expect(workflow).toContain('exit 1')
  })
})
