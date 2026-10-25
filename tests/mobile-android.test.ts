import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Nothing here can run Gradle — the release bundle needs the Android SDK and a
 * signed upload keystore that belongs to the owner. What is checked instead is
 * the set of facts that make the difference between a bundle Play accepts and
 * one it rejects, none of which announce themselves at build time.
 */

const file = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

const read = (relative: string): string => readFileSync(file(relative), 'utf8')

const APP = 'mobile/android/app/build.gradle'
const ROOT = 'mobile/android/build.gradle'
const VARIABLES = 'mobile/android/variables.gradle'
const WRAPPER = 'mobile/android/gradle/wrapper/gradle-wrapper.properties'

const majorMinor = (version: string): number => {
  const parts = version.split('.').map(Number)
  return (parts[0] ?? 0) * 100 + (parts[1] ?? 0)
}

describe('Android release bundle', () => {
  /**
   * Play requires targetSdk 36 for new apps and updates submitted from
   * 31 August 2026, and an upload built against 35 is refused at the console
   * with no hint that the compile setting is the reason.
   */
  it('targets the API level Play currently accepts', () => {
    const variables = read(VARIABLES)
    const targets = [...variables.matchAll(/targetSdkVersion = (\d+)/g)].map((m) => Number(m[1]))
    const compiles = [...variables.matchAll(/compileSdkVersion = (\d+)/g)].map((m) => Number(m[1]))

    expect(targets).toEqual([36])
    // compileSdk cannot trail targetSdk: AGP builds the manifest against it.
    expect(compiles).toEqual([36])
  })

  /**
   * AGP 8.9 is the first release whose supported API ceiling includes 36, and
   * each AGP line needs a minimum Gradle. Bumping one without the other fails
   * the build with an error that reads like a project problem.
   */
  it('uses an Android Gradle plugin and Gradle that can build API 36', () => {
    const agp = /com\.android\.tools\.build:gradle:([\d.]+)/.exec(read(ROOT))?.[1] ?? ''
    const gradle = /gradle-([\d.]+)-all\.zip/.exec(read(WRAPPER))?.[1] ?? ''

    expect(agp, 'AGP not found in the root build file').not.toBe('')
    expect(gradle, 'Gradle version not found in the wrapper properties').not.toBe('')

    expect(majorMinor(agp)).toBeGreaterThanOrEqual(majorMinor('8.9'))

    // Minimum Gradle per AGP line, from the compatibility table.
    const minimum = majorMinor(agp) >= majorMinor('8.13') ? '8.13' : '8.11'
    expect(majorMinor(gradle)).toBeGreaterThanOrEqual(majorMinor(minimum))
  })

  /** A committed version that drifts from the mobile package ships the wrong app. */
  it('defaults the version name to the mobile package version', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { version: string }
    expect(read(APP)).toContain(`?: "${pkg.version}"`)
  })

  /**
   * Play refuses a versionCode it has already seen, and there is no reliable
   * way to ask it for a free one, so the value has to come from something that
   * only ever increases.
   */
  it('takes the version code from the workflow rather than a constant', () => {
    const app = read(APP)
    expect(app).toContain('versionCode wardenVersionCode')
    expect(app).not.toMatch(/^\s*versionCode \d+$/m)

    const workflow = read('.github/workflows/mobile-android.yml')
    expect(workflow).toContain('-PwardenVersionCode=${CODE}')
    expect(workflow).toContain('code=${GITHUB_RUN_NUMBER}')
    expect(workflow).toContain('-PwardenVersionName=${VERSION}')
  })
})

describe('Play internal testing wiring', () => {
  const workflow = read('.github/workflows/mobile-android.yml')

  /** Internal testing needs no review, so it is the fastest path to a phone. */
  it('publishes to the internal track when it is configured to', () => {
    expect(workflow).toContain('r0adkll/upload-google-play')
    expect(workflow).toContain('packageName: us.innotel.warden')
    expect(workflow).toContain('tracks: internal')
    expect(workflow).toContain('serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}')
  })

  /**
   * An unsigned bundle is for inspection, and a dry run must never publish, so
   * the upload is gated on both the keystore and the service account.
   */
  it('only uploads a signed bundle with a service account', () => {
    const gate = "if: env.ANDROID_KEYSTORE_BASE64 != '' && env.PLAY_SERVICE_ACCOUNT_JSON != ''"
    expect(workflow).toContain(gate)
  })

  /** The artifact name is what a person looks for in the run's output. */
  it('names the bundle after the version', () => {
    expect(workflow).toContain('WARDEN-${VERSION}.aab')
    expect(workflow).toContain('warden-android-aab')
  })
})
