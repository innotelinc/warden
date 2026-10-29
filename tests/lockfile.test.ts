import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Two ways a release bump breaks an install rather than a build.
 *
 * The tag carries a version; `npm ci` on the runner then refuses to install if
 * the lockfile disagrees with its package.json — which is what a bump that
 * updates `package.json` and forgets the matching lockfile produces. And a
 * dependency entry whose recorded version and tarball disagree cannot be
 * downloaded at all, which is what editing a version number by hand produces.
 *
 * Neither is visible in `npm run build` on a machine that already has
 * node_modules, so both are asserted here, where the tag does not depend on
 * them being noticed.
 */

const file = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

const read = (relative: string): string => readFileSync(file(relative), 'utf8')

type Lock = {
  version: string
  packages: Record<string, { version?: string; resolved?: string; link?: boolean }>
}

const manifests = [
  { lock: 'package-lock.json', pkg: 'package.json' },
  { lock: 'mobile/package-lock.json', pkg: 'mobile/package.json' },
]

describe('lockfiles', () => {
  for (const { lock: lockPath, pkg: pkgPath } of manifests) {
    const lock = JSON.parse(read(lockPath)) as Lock
    const pkg = JSON.parse(read(pkgPath)) as { version: string }

    it(`${lockPath} is stamped with the package version`, () => {
      expect(lock.version).toBe(pkg.version)
      expect(lock.packages['']?.version).toBe(pkg.version)
    })

    it(`${lockPath} downloads each package at the version it records`, () => {
      const wrong: string[] = []
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (!entry?.resolved || entry.link) continue
        // Only registry tarballs encode the version in the URL; git, file and
        // alias resolutions legitimately do not.
        const match = /registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(entry.resolved)
        if (!match) continue
        if (match[1] !== entry.version) {
          wrong.push(`${path}: ${entry.version} recorded, ${match[1]} downloaded`)
        }
      }
      expect(wrong).toEqual([])
    })
  }
})
