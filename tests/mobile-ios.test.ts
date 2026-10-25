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
})
