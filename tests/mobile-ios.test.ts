import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The iOS project cannot be built in this repository's CI for Linux, so nothing
 * here compiles it. What is checked instead is the handful of facts that App
 * Store submission and the archive step depend on, each of which fails silently
 * on a macOS runner: a switch without its plist half, a version that drifts
 * from the mobile package, an icon the wrong shape, a manifest that stops
 * matching the listing.
 */

const file = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

const read = (relative: string): string => readFileSync(file(relative), 'utf8')

const PRODUCT = 'mobile/ios/App/App'
const PROJECT = 'mobile/ios/App/App.xcodeproj/project.pbxproj'

describe('iOS project', () => {
  /**
   * Capacitor only applies limitsNavigationsToAppBoundDomains when the plist
   * lists the domains it may stay on; the docs call the pair mandatory and the
   * failure mode is a bridge WebView that stops loading its own content.
   */
  it('pairs the app-bound-domain switch with the plist it needs', () => {
    const config = read('mobile/capacitor.config.ts')
    expect(config).toContain('limitsNavigationsToAppBoundDomains: true')

    const plist = read(`${PRODUCT}/Info.plist`)
    expect(plist).toContain('<key>WKAppBoundDomains</key>')
    expect(plist).toMatch(/<key>WKAppBoundDomains<\/key>\s*<array>\s*<string>localhost<\/string>/)
  })

  /** A marketing version that disagrees with the tag builds the wrong app. */
  it('stamps the mobile package version into the Xcode project', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { version: string }
    const versions = [...read(PROJECT).matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1])

    expect(versions.length).toBeGreaterThanOrEqual(2)
    expect(new Set(versions)).toEqual(new Set([pkg.version]))
  })

  /** `xcodebuild -scheme App` needs a scheme on the runner, not in Xcode's cache. */
  it('ships the shared scheme the archive step names', () => {
    const scheme = read('mobile/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme')
    expect(scheme).toContain('BlueprintName = "App"')

    const target = /isa = PBXNativeTarget;\s*buildConfigurationList = \w+ \/\* Build configuration list for PBXNativeTarget "App" \*\/;/.test(
      read(PROJECT)
    )
    expect(target).toBe(true)
  })

  /**
   * App Store Connect rejects a 1024 icon that carries transparency, and iOS
   * masks the corners itself, so the art has to be full-bleed.
   */
  it('ships a 1024 icon with no alpha channel', () => {
    const png = readFileSync(`${file(`${PRODUCT}/Assets.xcassets/AppIcon.appiconset`)}/AppIcon-1024.png`)

    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    const colorType = png.readUInt8(25)

    expect([width, height]).toEqual([1024, 1024])
    // 0 greyscale, 2 truecolour, 3 palette, 4 greyscale+alpha, 6 truecolour+alpha.
    expect([4, 6]).not.toContain(colorType)

    const contents = JSON.parse(
      read(`${PRODUCT}/Assets.xcassets/AppIcon.appiconset/Contents.json`)
    ) as { images: { filename: string; size: string }[] }
    expect(contents.images).toEqual([
      expect.objectContaining({ filename: 'AppIcon-1024.png', size: '1024x1024' })
    ])
  })

  /** The listing answers "Data Not Collected"; the bundle has to say the same. */
  it('declares the privacy position the listing answers with', () => {
    const manifest = read(`${PRODUCT}/PrivacyInfo.xcprivacy`)

    expect(manifest).toContain('<key>NSPrivacyTracking</key>')
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/)
    expect(manifest).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/)
    expect(manifest).toContain('NSPrivacyAccessedAPICategoryUserDefaults')
  })

  /** Export compliance is pre-answered, otherwise every upload is held. */
  it('answers export compliance in the plist', () => {
    expect(read(`${PRODUCT}/Info.plist`)).toMatch(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/
    )
  })

  /**
   * Xcode 26 supports iOS 15 and later; a project left at 14.0 is below the
   * range its SDK documents. The Podfile and the project also have to agree, or
   * `pod install` rewrites the target and the archive builds at a different
   * minimum than the one committed.
   */
  it('keeps every deployment target at the Xcode 26 floor', () => {
    const targets = [...read(PROJECT).matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(
      (m) => m[1]
    )

    expect(targets.length).toBeGreaterThanOrEqual(2)
    expect(new Set(targets)).toEqual(new Set(['15.0']))
    expect(read('mobile/ios/App/Podfile')).toContain("platform :ios, '15.0'")
  })
})

/**
 * Nothing in this repository can build for iOS, so the workflow is the only
 * thing standing between a green run and a rejected upload. The macos-15 image
 * defaults to Xcode 16.4 / the iOS 18.5 SDK, and App Store Connect accepts
 * nothing below the iOS 26 SDK: the build uploaded and was then thrown out on
 * analysis. Both halves of the guard are asserted, because without the first
 * the run builds against the old SDK and without the second it finds out ten
 * minutes later.
 */
describe('iOS workflow', () => {
  const workflow = read('.github/workflows/mobile-ios.yml')

  it('selects a current Xcode instead of the image default', () => {
    expect(workflow).toContain('maxim-lobanov/setup-xcode')
    expect(workflow).toMatch(/xcode-version:\s*(latest-stable|['"]?26)/)
    expect(workflow.indexOf('setup-xcode')).toBeLessThan(workflow.indexOf('name: Archive'))
  })

  it('refuses an SDK that App Store Connect will reject', () => {
    expect(workflow).toContain('xcrun --sdk iphoneos --show-sdk-version')
    expect(workflow).toMatch(/-lt 26/)
    expect(workflow.indexOf('--show-sdk-version')).toBeLessThan(workflow.indexOf('name: Archive'))
  })

  /**
   * `destination=upload` hands the build straight to App Store Connect and
   * leaves no .ipa behind. Naming the file without checking for it turned a
   * successful upload into a failed run.
   */
  it('does not require an ipa on disk after an upload', () => {
    expect(workflow).toContain('if [ ! -d "$RUNNER_TEMP/export" ]')
  })
})

/**
 * "Upload succeeded" is not "installable": Apple processes the build for a
 * while afterwards and may still throw it out. The status workflow is the only
 * way to ask what actually became of it, so it has to stay wired to the script
 * and to the same key the build uses.
 */
describe('iOS build status workflow', () => {
  const status = read('.github/workflows/ios-build-status.yml')
  const script = read('scripts/ios-build-status.py')

  it('runs the status script with the App Store Connect secrets', () => {
    expect(status).toContain('python3 scripts/ios-build-status.py')
    expect(status).toContain('secrets.APP_STORE_CONNECT_KEY_ID')
    expect(status).toContain('secrets.APP_STORE_CONNECT_ISSUER_ID')
    expect(status).toContain('secrets.APP_STORE_CONNECT_KEY_P8')
  })

  /** Every state the API can report has to mean something to a human. */
  it('explains each state the API can return', () => {
    for (const state of ['PROCESSING', 'VALID', 'FAILED', 'INVALID']) {
      expect(script).toContain(`"${state}"`)
    }
    expect(script).toContain('us.innotel.warden')
  })
})

/**
 * App Distribution installs an ad hoc build, not an App Store one, so it cannot
 * reuse the ipa the TestFlight export produces — and on a tag that export writes
 * nothing at all. A separate ad hoc export is the only thing that can be
 * installed by a tester, and it stays behind a configuration gate because the
 * profile it needs names each tester's device.
 */
describe('iOS App Distribution', () => {
  const workflow = read('.github/workflows/mobile-ios.yml')

  it('exports an ad hoc ipa rather than reusing the store one', () => {
    expect(workflow).toContain('<key>method</key><string>ad-hoc</string>')
    expect(workflow).toContain('-exportOptionsPlist "$RUNNER_TEMP/AdHocOptions.plist"')
  })

  it('publishes only with an app id, a service account and an upload', () => {
    expect(workflow).toContain(
      "if: steps.upload.outputs.sideload == 'true' || (env.FIREBASE_IOS_APP_ID != '' && steps.upload.outputs.value == 'true')"
    )
    expect(workflow).toContain(
      "if: env.FIREBASE_IOS_APP_ID != '' && env.FIREBASE_SERVICE_ACCOUNT != '' && steps.upload.outputs.value == 'true'"
    )
    expect(workflow).toContain('appdistribution:distribute')
  })
})

/**
 * A manual run is how the archive is checked after an Xcode or SDK change. It
 * used to archive, export an ad hoc ipa and email it to the tester group as
 * well, whether or not an upload was asked for — so "does it still compile"
 * spent a build number on TestFlight and interrupted every tester. The tick box
 * is the whole decision now, and it covers the store export too.
 */
describe('iOS manual runs', () => {
  const workflow = read('.github/workflows/mobile-ios.yml')

  /** The `if:` that belongs to a named step. */
  const gate = (step: string): string =>
    workflow
      .slice(workflow.indexOf(`- name: ${step}`))
      .split('\n')
      .find((line) => line.trimStart().startsWith('if:')) ?? ''

  it('stops at the archive until upload_to_testflight is ticked', () => {
    expect(workflow).toContain(
      "REQUESTED: ${{ github.event_name == 'push' || inputs.upload_to_testflight }}"
    )
    for (const step of [
      'Export ipa',
      'Export an ad hoc ipa',
      'Check the ad hoc profile names the registered devices',
      'Publish to Firebase App Distribution',
    ]) {
      expect(gate(step), step).toContain("steps.upload.outputs.value == 'true'")
    }
  })

  it('no longer writes an ipa that nobody asked to upload', () => {
    expect(workflow).not.toContain("'upload' || 'export'")
    expect(workflow).toContain('<key>destination</key><string>upload</string>')
  })

  /**
   * Checking a build on one's own phone is not a release. The ad hoc export is
   * the only thing that produces an ipa a registered device will install, so it
   * is offered on its own: no TestFlight upload, no App Distribution release, no
   * email. The store export stays behind `value` because that one exists only to
   * be uploaded.
   */
  it('exports a signed ipa for sideloading without telling anyone', () => {
    expect(workflow).toMatch(
      /export_signed_ipa:\s*\n\s*description: Export a signed ad hoc \.ipa for sideloading \(publishes nothing\)\s*\n\s*type: boolean\s*\n\s*default: false/
    )
    expect(workflow).toContain('SIDELOAD_REQUESTED: ${{ inputs.export_signed_ipa }}')

    expect(gate('Export an ad hoc ipa')).toContain("steps.upload.outputs.sideload == 'true'")
    expect(gate('Check the ad hoc profile names the registered devices')).toContain(
      "steps.upload.outputs.sideload == 'true'"
    )

    expect(gate('Export ipa')).not.toContain('sideload')
    expect(gate('Publish to Firebase App Distribution')).not.toContain('sideload')
  })
})

/**
 * An ad hoc profile names the devices it may be installed on, and Apple offers no
 * way to add one except registering it: the export fails while the account has
 * no devices at all. The key that can register one is a secret, so the call
 * belongs on a runner — and it has to keep using the same three secrets as every
 * other App Store Connect call, or it will look configured and still fail.
 */
describe('iOS device registration', () => {
  const workflow = read('.github/workflows/ios-register-device.yml')
  const script = read('scripts/ios-register-device.py')

  it('runs the registration script with the App Store Connect secrets', () => {
    expect(workflow).toContain('python3 scripts/ios-register-device.py')
    for (const secret of ['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_KEY_P8']) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
  })

  it('registers an iOS device and treats a known UDID as done', () => {
    expect(script).toContain('"platform": "IOS"')
    expect(script).toContain('"POST",\n        "/v1/devices"')
    expect(script).toContain('if error.code == 409')
  })
})

/**
 * A signed export is not an installable one. Xcode will sign with a profile that
 * names no phone — or a stale one that predates the latest registration — and
 * the run goes green while the tester's phone refuses the build. The check has
 * to happen on the ipa being published, and before the publish, or it reports a
 * failure that has already reached everyone's inbox.
 */
describe('iOS ad hoc profile check', () => {
  const workflow = read('.github/workflows/mobile-ios.yml')
  const script = read('scripts/verify-adhoc-profile.py')

  it('runs on the exported ipa before it is distributed', () => {
    expect(workflow).toContain('scripts/verify-adhoc-profile.py')
    expect(workflow.indexOf('Check the ad hoc profile names the registered devices')).toBeLessThan(
      workflow.indexOf('name: Publish to Firebase App Distribution')
    )
  })

  it('compares the embedded profile with the account, and fails loudly', () => {
    expect(script).toContain('embedded.mobileprovision')
    expect(script).toContain('/v1/devices')
    expect(script).toContain('ProvisionedDevices')
    expect(script).toContain('::error::')
    expect(script).toContain('ios-register-device.yml')
  })
})


/**
 * 'Upload succeeded' is the last thing Xcode says, and it is not the last thing
 * that has to happen: App Store Connect processes the build and then hands it to
 * nobody until a TestFlight group with testers in it holds it. Every release
 * before this one went green at the upload and left that question unanswered, so
 * the gate lives in the job that uploads — after the upload, and before the
 * artifact upload that ends the job, or it gates nothing.
 */
describe('iOS TestFlight gate', () => {
  const workflow = read('.github/workflows/mobile-ios.yml');
  const script = read('scripts/ios-build-status.py');

  it('waits for the build to reach a tester after uploading it', () => {
    expect(workflow).toContain('--await-testers');
    expect(workflow).toContain('--wait-minutes 45');
    expect(workflow.indexOf('Wait for TestFlight to publish the build')).toBeGreaterThan(
      workflow.indexOf('name: Export ipa')
    );
    expect(workflow.indexOf('Wait for TestFlight to publish the build')).toBeLessThan(
      workflow.indexOf('uses: actions/upload-artifact@v4')
    );
  });

  /** Asking whether a build is installable should not require cutting a tag. */
  it('is reachable on its own from the status workflow', () => {
    expect(read('.github/workflows/ios-build-status.yml')).toContain('args+=(--await-testers)');
  });

  /** A manual sideload run uploads nothing, so it has nothing to wait for. */
  it('runs only when the build was uploaded', () => {
    const step = workflow.slice(workflow.indexOf('Wait for TestFlight to publish the build'));
    expect(step.slice(0, step.indexOf('run: |'))).toContain("steps.upload.outputs.value == 'true'");
  });

  /**
   * A gate that only refuses leaves the tag red and the build still in nobody's
   * TestFlight. The step owns the group choice instead: internal groups first
   * (no Beta App Review), then the widest audience, so the same account state
   * always yields the same group and no release is left for someone to finish by
   * hand.
   */
  it('adds the build to a group that has testers before giving up', () => {
    const gate = script.slice(script.indexOf('def await_testers'), script.indexOf('def select_target'));
    expect(gate).toContain('assign_to_group');
    expect(gate).toContain('conflict_is_ok=True');
    expect(gate).toContain('continue');
    // The assignment is an attempt, not a promise: the refusal stays.
    expect(gate).toContain('return 4');
    expect(script).toContain('not group["internal"]');
  });

  it('explains each way a build fails to become installable', () => {
    expect(script).toContain('no TestFlight group exists');
    expect(script).toContain('no TestFlight group holds build');
    expect(script).toContain('no tester belongs to');
    expect(script).toContain('::error::');
    expect(script).toContain('return 4');
  });
});
