import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * A capture that stays on disk fills no slot. Uploading by hand is how the wrong
 * set lands in the 6.9-inch slot, and how one slot ends up holding captures from
 * two runs. The script writes the slots through the API instead, in three steps
 * Apple documents: reserve a screenshot record, send the bytes, confirm it with
 * the file's MD5. A record that is reserved and never confirmed fills the slot
 * with an empty image, which is the failure this pins.
 */
describe('the upload script', () => {
  const script = read('scripts/ios-upload-screenshots.py')

  it('writes each file into the slot its name says', () => {
    expect(script).toContain('"APP_IPHONE_67", (1260, 1290, 1320)')
    expect(script).toContain('"APP_IPAD_PRO_3GEN_129", (2048, 2064)')
  })

  it('refuses a file its slot would not take', () => {
    expect(script).toContain('is not a PNG')
    expect(script).toContain('height <= width')
    expect(script).toContain('::error::')
  })

  it('refuses two screens that are the same picture', () => {
    expect(script).toContain('is identical to')
    expect(script).toContain('hashlib.sha256')
  })

  it('needs the three the slot requires, not just one', () => {
    expect(script).toContain('asc.MIN_SHOTS_PER_SIZE')
  })

  it('confirms every upload with its checksum, then waits for delivery', () => {
    expect(script).toContain('"/v1/appScreenshots"')
    expect(script).toContain('uploadOperations')
    expect(script).toContain('sourceFileChecksum')
    expect(script).toContain('hashlib.md5')
    expect(script).toContain('assetDeliveryState')
  })

  it('does not mix two captures in one slot unless told to', () => {
    expect(script).toContain('--replace')
    expect(script).toContain('a mix of two')
  })

  it('is what the upload workflow runs', () => {
    const workflow = read('.github/workflows/ios-screenshots.yml')
    expect(workflow).toContain('python3 scripts/ios-upload-screenshots.py')
    expect(workflow).toContain('gh run download')
    expect(workflow).toContain('warden-ios-screenshots')
    expect(workflow).toContain('actions: read')
  })
})

/**
 * The listings' `graphics` block is copied into the console by hand, and it had
 * drifted from the thing it describes: it recorded a single 1290x2796 phone set
 * and two 2048x2732 iPads while the capture writes three shots per slot at the
 * simulator's own pixels, and the Play block named three PNGs nothing produces
 * and an icon and feature graphic that are not in the repository. A manifest
 * that names files and sizes nobody will find reads as work that is already
 * done, and the mistake surfaces at submission.
 *
 * So the block is pinned to the scripts that make the files: slot keys, labels,
 * API display types, accepted widths and file names come from
 * ios-capture-screenshots.py, and the minimum count from the submission check.
 */
describe('the listings describe the graphics that exist', () => {
  interface CapturedSlot {
    key: string
    label: string
    display: string
    widths: number[]
  }

  const capture = read('scripts/ios-capture-screenshots.py')

  const slots: CapturedSlot[] = [
    ...capture.matchAll(
      /Slot\(\s*key="([^"]+)",\s*label=["']([^"']+)["'],[\s\S]*?display_type="([^"]+)",\s*widths=\(([^)]*)\)/g
    )
  ].map((match) => {
    const [, key = '', label = '', display = '', widths = ''] = match
    return {
      key,
      label,
      display,
      widths: widths.split(',').map((value) => Number(value.trim()))
    }
  })

  const steps = [
    ...capture.matchAll(/^ {4}\("([a-z]+)",\s*(?:None|tour_link\("[a-z]+"\),?)\s*,\s*"([^"]+)"\),$/gm)
  ].map((match) => {
    const [, name = '', description = ''] = match
    return { name, description }
  })

  const minimum = Number(
    /MIN_SHOTS_PER_SIZE = (\d+)/.exec(read('scripts/ios-build-status.py'))?.[1]
  )

  interface DescribedSlot {
    label: string
    display: string
    widths: number[]
    captured: string
    files: string[]
    content: string[]
  }

  const ios = JSON.parse(read('mobile/store/ios/listing.json')) as {
    graphics: { appIcon: string; screenshots: Record<string, DescribedSlot> }
  }
  const android = JSON.parse(read('mobile/store/android/listing.json')) as {
    graphics: {
      icon: string | null
      featureGraphic: string | null
      phoneScreenshots: string[]
      requiredScreens: string[]
      note: string
    }
  }

  /** A slot the manifest forgot is a failure, not a skipped loop. */
  const describedSlot = (key: string): DescribedSlot => {
    const described = ios.graphics.screenshots[key]
    if (!described) throw new Error(`the iOS listing describes no ${key} screenshots`)
    return described
  }

  /** If either script is reshaped, fail here rather than check an empty set. */
  it('reads the slots and screens the capture runs', () => {
    expect(slots.map((slot) => slot.key)).toEqual(['iphone-6.9', 'ipad-13'])
    expect(slots.map((slot) => slot.display)).toEqual([
      'APP_IPHONE_67',
      'APP_IPAD_PRO_3GEN_129'
    ])
    expect(steps.map((step) => step.name)).toEqual(['posture', 'browse', 'scry'])
    expect(minimum).toBe(3)
  })

  it('describes both slots by API name, label and accepted sizes', () => {
    expect(Object.keys(ios.graphics.screenshots).sort()).toEqual(
      slots.map((slot) => slot.key).sort()
    )
    for (const slot of slots) {
      const described = describedSlot(slot.key)
      expect(described.label, slot.key).toBe(slot.label)
      expect(described.display, slot.key).toBe(slot.display)
      expect(described.widths, slot.key).toEqual(slot.widths)
    }
  })

  /** The names are the capture's, so the upload script's glob finds them. */
  it('names the three files the capture writes for each slot', () => {
    for (const slot of slots) {
      const described = describedSlot(slot.key)
      expect(described.files, slot.key).toEqual(
        steps.map((step, index) => `${slot.key}-${index + 1}-${step.name}.png`)
      )
      expect(described.files.length, slot.key).toBeGreaterThanOrEqual(minimum)
      expect(described.content, slot.key).toEqual(steps.map((step) => step.description))
    }
  })

  /** A recorded size outside the slot's widths is the drift this pins. */
  it('records a captured size its slot accepts', () => {
    for (const slot of slots) {
      const size = /^(\d+) x (\d+)$/.exec(describedSlot(slot.key).captured)
      expect(size, slot.key).not.toBeNull()
      const [width, height] = [Number(size![1]), Number(size![2])]
      expect(slot.widths, slot.key).toContain(width)
      expect(height, slot.key).toBeGreaterThan(width)
    }
  })

  it('points the icon at the file the bundle actually holds', () => {
    expect(existsSync(file(ios.graphics.appIcon))).toBe(true)
  })

  /**
   * Play holds no graphics until they exist. When they do, a name beside the
   * manifest has to be a file that is there, and Play wants two or more shots.
   */
  it('names no Play graphic that does not exist', () => {
    expect(android.graphics.icon).toBeNull()
    expect(android.graphics.featureGraphic).toBeNull()
    expect(android.graphics.phoneScreenshots).toEqual([])
    expect(android.graphics.note).toMatch(/no Play graphics are in the repository yet/i)
    expect(android.graphics.requiredScreens).toEqual(steps.map((step) => step.description))

    if (android.graphics.phoneScreenshots.length > 0) {
      expect(android.graphics.phoneScreenshots.length).toBeGreaterThanOrEqual(2)
      for (const name of android.graphics.phoneScreenshots) {
        expect(existsSync(file(`mobile/store/android/${name}`)), name).toBe(true)
      }
    }
  })
})
