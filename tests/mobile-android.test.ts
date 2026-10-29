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
   * the upload is gated on both the keystore and the service account, and on the
   * run not being a manual dry run.
   */
  it('only uploads a signed bundle with a service account', () => {
    const gate =
      "if: env.DRY_RUN != 'true' && env.ANDROID_KEYSTORE_BASE64 != '' && env.PLAY_SERVICE_ACCOUNT_JSON != ''"
    expect(workflow).toContain(gate)
  })

  /**
   * Play has no undo, so a manual run has to be able to stop short of the track
   * — that is how the CI gate and the signing get exercised. The input is off
   * unless ticked, and a tag push carries no inputs at all, which is what keeps
   * a release a release.
   */
  it('lets a manual run stop short of the track', () => {
    expect(workflow).toMatch(
      /workflow_dispatch:\s*\n\s*inputs:\s*\n(?:\s*#[^\n]*\n)*\s*dry_run:\s*\n\s*description: Build and sign without uploading to Play\s*\n\s*type: boolean\s*\n\s*default: false/
    )
    expect(workflow).toContain('DRY_RUN: ${{ inputs.dry_run }}')
    expect(workflow).toContain(
      'Dry run — the bundle was built and signed but not uploaded to Play.'
    )
  })

  /** The artifact name is what a person looks for in the run's output. */
  it('names the bundle after the version', () => {
    expect(workflow).toContain('WARDEN-${VERSION}.aab')
    expect(workflow).toContain('warden-android-aab')
  })
})

describe('Installing a build without Play', () => {
  const workflow = read('.github/workflows/mobile-android.yml')

  /**
   * An .aab is a Play upload, not something a phone installs. The free route to
   * a test device is the APK, and it has to be built on every run — including
   * the dry runs that never touch the track — signed when the keystore exists
   * and debug-signed when it does not.
   */
  it('builds an APK that a phone can install', () => {
    expect(workflow).toContain('./gradlew assembleRelease')
    expect(workflow).toContain('./gradlew assembleDebug')
    expect(workflow).toContain('WARDEN-${VERSION}.apk')
    expect(workflow).toContain('warden-android-apk')
  })

  /**
   * The release asset keeps one name across versions, so
   * `/releases/latest/download/WARDEN-android.apk` is a link a phone can
   * bookmark instead of one that has to be dug out of each release.
   */
  it('attaches the APK under a name that survives versions', () => {
    expect(workflow).toContain('$RUNNER_TEMP/apk/WARDEN-android.apk" --clobber')
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v')")
  })
})

/**
 * Distribution is optional in the repository and configured by the owner, so the
 * wiring has to be inert until it is: a fork, a dry run and a repository with no
 * Firebase project must all behave exactly as they did before it existed.
 */
describe('Android App Distribution', () => {
  const workflow = read('.github/workflows/mobile-android.yml')

  it('sends the APK it just built to the configured project', () => {
    expect(workflow).toContain('appdistribution:distribute "$APK_PATH"')
    expect(workflow).toContain('--app "$FIREBASE_ANDROID_APP_ID"')
    expect(workflow).toContain("echo \"APK_PATH=")
  })

  it('publishes only on a run that means to distribute', () => {
    expect(workflow).toContain(
      "if: env.DRY_RUN != 'true' && env.FIREBASE_ANDROID_APP_ID != '' && env.FIREBASE_SERVICE_ACCOUNT != ''"
    )
  })
})

/**
 * Android will not replace a debug-signed install with a release-signed one, and
 * the two APKs are identical in every way a run can see: same name, same build,
 * same artifact. So the signer certificate is the only thing that can tell them
 * apart, and it has to be checked before distribution rather than after a tester
 * reports that an update will not install.
 */
describe('APK signing check', () => {
  const workflow = read('.github/workflows/mobile-android.yml')
  const script = read('scripts/verify-apk-signature.py')

  it('checks the APK before anything is published', () => {
    expect(workflow).toContain('scripts/verify-apk-signature.py')
    expect(workflow.indexOf('Check the APK is signed with the upload key')).toBeLessThan(
      workflow.indexOf('name: Publish to Firebase App Distribution')
    )
    expect(workflow.indexOf('Check the APK is signed with the upload key')).toBeLessThan(
      workflow.indexOf('name: Attach the APK to the release')
    )
  })

  it('pins the upload key rather than trusting the keystore it just used', () => {
    expect(script).toContain('62:EB:DA:C2')
    expect(script).toContain('::error::')
    expect(script).toContain('debug-signed')
    expect(script).toContain('META-INF/')
  })
})

/**
 * Play publishing is the one publishing step that depends on something no
 * workflow can create: a package in Play Console, and a service account invited
 * to it. Making it opt-in keeps a tag's free channels — Firebase, the release
 * page — from going red over a console that is not set up yet, and keeping it
 * last means a rejection there cannot strand the APK asset.
 */
describe('Play publishing switch', () => {
  const workflow = read('.github/workflows/mobile-android.yml')

  it('stays off until the PLAY_PUBLISH variable says otherwise', () => {
    expect(workflow).toContain('PLAY_PUBLISH: ${{ vars.PLAY_PUBLISH }}')
    expect(workflow).toContain("env.PLAY_PUBLISH == 'true'")
  })

  it('runs after the APK has reached the release page', () => {
    expect(workflow.indexOf('name: Attach the APK to the release')).toBeLessThan(
      workflow.indexOf('Upload to Play internal testing')
    )
  })
})

/**
 * A signature check says the bytes are signed; it says nothing about whether a
 * phone will take them. Every APK up to 0.2.12 was verified with apksigner and
 * installed nowhere, so "it installs" was an inference. This job turns it into a
 * fact, on a device with nothing on it.
 */
describe('Installing the published APK on a device', () => {
  const workflow = read('.github/workflows/mobile-android.yml')
  const script = read('scripts/verify-android-install.py')

  it('runs after the bundle job, on the APK that job built', () => {
    expect(workflow).toMatch(/\n  install:\n    needs: bundle\n/)
    expect(workflow).toContain('reactivecircus/android-emulator-runner')
    expect(workflow).toContain('actions/download-artifact@v4')
    expect(workflow).toContain('script: python3 scripts/verify-android-install.py')
  })

  /**
   * The action runs `script` one line at a time, each in a fresh /bin/sh, so
   * shell state does not survive it: the first version of this check lost its
   * APK between two lines and installed nothing at all.
   */
  it('hands the runner one command rather than inline shell', () => {
    expect(workflow).not.toContain('pipefail')
  })

  it('installs it, resolves the launcher and launches it', () => {
    expect(script).toContain('"install", apk')
    expect(script).toContain('"resolve-activity"')
    expect(script).toContain('"-W"')
    expect(script).toContain('"pidof"')
    expect(script).toContain('Status: ok')
  })

  /**
   * The artifact and the release asset share a name and a build number, so a
   * stale download would pass an install check against the wrong build.
   */
  it('refuses a device whose version is not the one that was built', () => {
    expect(workflow).toContain(
      'outputs:\n      version: ${{ steps.version.outputs.version }}'
    )
    expect(workflow).toContain('VERSION: ${{ needs.bundle.outputs.version }}')
    expect(script).toContain('versionName=')
    expect(script).toContain('installed artifact is not the one that was published')
  })

  /** A launch that reports success and then dies is still a broken APK. */
  it('fails when the app is not in the foreground or has died', () => {
    expect(script).toContain('topResumedActivity')
    expect(script).toContain('mResumedActivity')
    expect(script).toContain('"-b", "crash"')
    expect(script).toContain('the process was gone')
  })

  /** An empty directory installs nothing and passes a check that trusts it. */
  it('refuses an artifact it cannot identify', () => {
    expect(script).toContain('expected exactly one .apk')
  })

  /** The package is named twice now, so the two are checked against each other. */
  it('checks the package the app declares', () => {
    const id = /applicationId "([^"]+)"/.exec(read(APP))?.[1]
    expect(id).toBeTruthy()
    expect(script).toContain(`PACKAGE = "${id}"`)
  })
})

/**
 * `npx --yes firebase-tools@15` re-fetched a 244 MB tree on every run — 24
 * minutes of the v0.2.12 iOS release — and even with that tree cached it asked
 * the registry which version the range meant, every run, failing when there was
 * no registry. Both workflows install a pinned version into a cached prefix and
 * call the binary instead. Asserted for both together, because a fix applied to
 * one of them is the way this comes back.
 */
describe('Firebase CLI', () => {
  const workflows = [
    read('.github/workflows/mobile-android.yml'),
    read('.github/workflows/mobile-ios.yml'),
  ]

  it('pins one version and installs exactly that', () => {
    for (const workflow of workflows) {
      expect(workflow).toContain("FIREBASE_TOOLS_VERSION: '15.34.1'")
      expect(workflow).toContain('"firebase-tools@${FIREBASE_TOOLS_VERSION}"')
    }
  })

  it('caches the install under the version that was installed', () => {
    for (const workflow of workflows) {
      expect(workflow).toContain('path: ~/.warden-firebase-tools')
      expect(workflow).toContain(
        'key: firebase-tools-${{ runner.os }}-${{ env.FIREBASE_TOOLS_VERSION }}'
      )
      expect(workflow).toContain("steps.firebase-tools.outputs.cache-hit != 'true'")
    }
  })

  it('publishes with the cached binary rather than npx', () => {
    for (const workflow of workflows) {
      expect(workflow).not.toContain('npx --yes firebase-tools')
      expect(workflow).toContain(
        '"$HOME/.warden-firebase-tools/node_modules/.bin/firebase" appdistribution:distribute'
      )
    }
  })

  /** A cache hit is a directory of files, so the CLI is proved to run first. */
  it('checks the cached CLI before the publish step needs it', () => {
    for (const workflow of workflows) {
      const check = workflow.indexOf('name: Check firebase-tools')
      expect(check).toBeGreaterThan(-1)
      expect(check).toBeLessThan(workflow.indexOf('appdistribution:distribute'))
    }
  })
})

/**
 * A runner starts with an empty ~/.gradle, so without a cache every release
 * downloaded the Gradle distribution and every dependency again — 123 s of the
 * Android job that produced nothing new. The three paths are cached together
 * because they belong together: the wrapper's download, the resolved
 * dependencies, and the local build cache that `org.gradle.caching` writes to.
 */
describe('Gradle cache', () => {
  const workflow = read('.github/workflows/mobile-android.yml')

  it('restores the distribution, the dependencies and the build cache', () => {
    for (const path of [
      '~/.gradle/wrapper/dists',
      '~/.gradle/caches/modules-2',
      '~/.gradle/caches/build-cache-1',
    ]) {
      expect(workflow).toContain(path)
    }
    expect(workflow).toContain('restore-keys: |')
    expect(workflow).toContain("hashFiles('mobile/android/gradle/wrapper/gradle-wrapper.properties'")
  })

  it('restores before Gradle runs', () => {
    const cache = workflow.indexOf('name: Cache Gradle')
    expect(cache).toBeGreaterThan(-1)
    expect(cache).toBeLessThan(workflow.indexOf('./gradlew "${args[@]}"'))
  })

  /** The cache path above is only written to when the build cache is enabled. */
  it('turns the build cache on in the project', () => {
    expect(read('mobile/android/gradle.properties')).toContain('org.gradle.caching=true')
  })
})
