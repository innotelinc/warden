import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTourStep } from '../mobile/src/capture-tour'

/**
 * The two screenshot sets App Store Connect requires cannot be typed in, and
 * they cannot be photographed without the device: they have to be captures of
 * the running app at the exact sizes the slots accept. Two things make that
 * possible, and both fail silently.
 *
 * - The submission check has to look for the *slot*. Its first version matched
 *   any `APP_IPHONE_*` set, so a 6.5-inch upload read `ok` and the refusal
 *   arrived at submission instead.
 * - The capture has to reach the product's own screens. Nothing on a simulator
 *   can tap, so the app answers `warden://` addresses and the script opens them.
 *
 * Neither half exists on Linux, so each is pinned here: the parse as code, the
 * wiring as the text that has to keep matching.
 */

const file = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

const read = (relative: string): string => readFileSync(file(relative), 'utf8')

const link = (screen: string): string =>
  `warden://${screen}?url=${encodeURIComponent('https://example.com')}`

describe('the capture tour', () => {
  it('opens a page in WARDEN for the browse screen', () => {
    expect(parseTourStep(link('browse'))).toEqual({
      screen: 'browse',
      url: 'https://example.com/'
    })
  })

  it('reads a page for the scry screen', () => {
    expect(parseTourStep(link('scry'))).toEqual({
      screen: 'scry',
      url: 'https://example.com/'
    })
  })

  it('keeps the query, so a shot can show a page with one', () => {
    const raw = `warden://scry?url=${encodeURIComponent('https://example.com/?a=1&b=2')}`
    expect(parseTourStep(raw)?.url).toBe('https://example.com/?a=1&b=2')
  })

  it('refuses anything that is not one of the two pages', () => {
    // A scheme a page can open must not become a way to open a file, run a
    // script, or start another app.
    for (const raw of [
      null,
      undefined,
      '',
      'https://example.com',
      'warden://settings',
      'warden://browse',
      `warden://browse?url=${encodeURIComponent('file:///etc/passwd')}`,
      `warden://scry?url=${encodeURIComponent('javascript:alert(1)')}`,
      'warden://browse?url=not%20a%20url'
    ]) {
      expect(parseTourStep(raw), String(raw)).toBe(null)
    }
  })
})

describe('the tour reaches the app', () => {
  /**
   * A launch argument, not a `warden://` URL opened on a running app: iOS 26
   * puts an "Open in WARDEN Mobile?" prompt in front of that, and the first
   * capture run photographed the prompt three times because a simulator cannot
   * tap it. Nothing may quietly reintroduce the scheme path.
   */
  it('is a launch argument the plugin reads', () => {
    const plugin = read('mobile/plugins/warden-browser/ios/Sources/WardenBrowserPlugin.swift')
    expect(plugin).toContain('CAPPluginMethod(name: "launchTour"')
    expect(plugin).toContain('"-wardenTour"')
    expect(plugin).toContain('ProcessInfo.processInfo.arguments')

    expect(read('mobile/ios/App/App/Info.plist')).not.toContain('CFBundleURLTypes')
    expect(read('mobile/ios/App/App/AppDelegate.swift')).not.toContain('warden.captureTour')
  })

  it('is what the shell asks for, and both screens come from it', () => {
    expect(read('mobile/src/warden-browser.ts')).toContain('launchTour()')

    const shell = read('mobile/src/App.tsx')
    expect(shell).toContain('WardenBrowser.launchTour()')
    expect(shell).toContain('parseTourStep')
    expect(shell).toContain('tourUrl={tourUrl}')
    // Scry is captured on arrival, not left on an empty field: the shot it
    // takes has to be the report.
    expect(read('mobile/src/panels/ScryPanel.tsx')).toContain('capture(tourUrl)')
  })
})

describe('the capture script', () => {
  const script = read('scripts/ios-capture-screenshots.py')

  it('is macOS only, and says so before booting anything', () => {
    expect(script).toContain('sys.platform != "darwin"')
  })

  /** The two slots, and the widths each one accepts. */
  it('knows both slots and the sizes they take', () => {
    expect(script).toContain('APP_IPHONE_67')
    expect(script).toContain('APP_IPAD_PRO_3GEN_129')
    expect(script).toContain('widths=(1260, 1290, 1320)')
    expect(script).toContain('widths=(2048, 2064)')
  })

  it('drives the app through the argument the shell answers', () => {
    expect(script).toContain('warden://{screen}?url=')
    for (const screen of ['browse', 'scry']) {
      expect(script).toContain(`tour_link("${screen}")`)
    }
    expect(script).toContain('"-wardenTour"')
    // Each screen is its own launch, so a page or a report cannot leak into the
    // next shot and a stale prompt cannot cover the app.
    expect(script).toContain('--terminate-running-process')
    expect(script).toContain('"screenshot"')
  })

  /** Size alone passed three pictures of the same system prompt. */
  it('refuses two screens that are the same picture', () => {
    expect(script).toContain('check_distinct')
    expect(script).toContain('hashlib.sha256')
    expect(script).toContain('the app never reached')
  })

  /** A file the console would refuse must fail here, not at upload. */
  it('refuses a capture that is not a portrait PNG of its slot', () => {
    expect(script).toContain('b"\\x89PNG\\r\\n\\x1a\\n"')
    expect(script).toContain('height <= width')
    expect(script).toContain('::error::')
  })

  it('is the step this workflow runs', () => {
    const workflow = read('.github/workflows/mobile-ios.yml')
    expect(workflow).toContain('capture_screenshots:')
    expect(workflow).toContain('if: inputs.capture_screenshots')
    expect(workflow).toContain('python3 scripts/ios-capture-screenshots.py')
    expect(workflow).toContain('name: warden-ios-screenshots')
  })
})

/**
 * The refusal this check exists to catch: a 6.5-inch set is an iPhone set, it is
 * not a 6.9-inch set, and App Store Connect will not put it in that slot. The
 * report has to say so while there is still time to take the right shots.
 */
describe('the submission check looks for the slots', () => {
  const script = read('scripts/ios-build-status.py')

  it('requires the two slots by name', () => {
    expect(script).toContain('REQUIRED_SHOTS')
    expect(script).toContain('("APP_IPHONE_67",)')
    expect(script).toContain('("APP_IPAD_PRO_3GEN_129",)')
  })

  it('no longer accepts any set from the family', () => {
    expect(script).not.toContain('startswith("APP_IPHONE")')
    expect(script).not.toContain('startswith("APP_IPAD")')
    expect(script).not.toContain('RECOMMENDED_SHOTS')
  })

  it('counts three in the slot, and says what it found otherwise', () => {
    expect(script).toContain('MIN_SHOTS_PER_SIZE = 3')
    expect(script).toContain('needs {MIN_SHOTS_PER_SIZE}')
    expect(script).toContain('found {found}')
  })
})
