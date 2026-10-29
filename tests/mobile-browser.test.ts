import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The mobile app used to launch the platform's browser: Android handed the
 * address to Chrome Custom Tabs, so WARDEN had no address bar of its own and was
 * a launcher with a home screen. Nothing here can start an emulator, so what is
 * checked is the set of facts that make the difference between the app being a
 * browser and being a shell — that a native surface exists on both platforms,
 * that the shell opens it, and that the blocking lists have not drifted apart.
 */

const file = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url))
const read = (relative: string): string => readFileSync(file(relative), 'utf8')

const ANDROID = 'mobile/plugins/warden-browser/android/src/main/java/us/innotel/warden/browser'
const ACTIVITY = `${ANDROID}/WardenBrowserActivity.java`
const RULES = `${ANDROID}/WardenAdBlock.java`
const PLUGIN = `${ANDROID}/WardenBrowserPlugin.java`
const SWIFT_RULES = 'mobile/plugins/warden-browser/ios/Sources/WardenAdBlocker.swift'

describe('the Android browser surface', () => {
  it('is a real page engine with chrome, not a hand-off to another app', () => {
    const activity = read(ACTIVITY)
    // A WebView for the page, and our own controls around it.
    expect(activity).toContain('webView = new WebView(this)')
    expect(activity).toContain('class WardenBrowserActivity extends Activity')
    expect(activity).toContain('new EditText(this)')
    expect(activity).toContain('setImeOptions(EditorInfo.IME_ACTION_GO)')
    expect(activity).toContain('if (webView.canGoBack())')
    expect(activity).toContain('webView.reload()')
    // Everything that is not a web page belongs to the system, as in any browser.
    expect(activity).toContain('new Intent(Intent.ACTION_VIEW, uri)')
  })

  /**
   * The module has to compile. Kotlin was written here first and the AGP module
   * had no Kotlin plugin, so the build succeeded and shipped an APK with none of
   * the browser in it — only the generated `R` class. Java is what this module
   * compiles, so the sources are Java and there is no second toolchain to wire in.
   */
  it('ships sources the module actually compiles', () => {
    expect(read('mobile/plugins/warden-browser/android/build.gradle')).not.toContain('kotlin')
    for (const file of [ACTIVITY, RULES, PLUGIN]) {
      expect(read(file)).toContain('package us.innotel.warden.browser;')
    }
  })

  it('is registered, so `cap sync` builds it into the app', () => {
    const pkg = JSON.parse(read('mobile/plugins/warden-browser/package.json'))
    expect(pkg.capacitor.android.src).toBe('android')
    expect(read('mobile/android/capacitor.settings.gradle')).toContain("include ':warden-browser'")
    expect(read('mobile/android/app/capacitor.build.gradle')).toContain("project(':warden-browser')")
    expect(read('mobile/plugins/warden-browser/android/src/main/AndroidManifest.xml')).toContain(
      '.WardenBrowserActivity'
    )
  })

  it('bridges navigation back to the shell', () => {
    const plugin = read(PLUGIN)
    expect(plugin).toContain('@CapacitorPlugin(name = "WardenBrowser")')
    expect(plugin).toContain('public void open(PluginCall call)')
    expect(plugin).toContain('notifyListeners("navigated"')
    expect(read(ACTIVITY)).toContain('WardenBrowserPlugin.emitNavigated')
  })

  /**
   * Blocking has to happen before the request leaves the app, which on Android is
   * `shouldInterceptRequest` — the same decision point the desktop filter is.
   */
  it('refuses ad requests, and clears the slot they leave behind', () => {
    const activity = read(ACTIVITY)
    expect(activity).toContain('public WebResourceResponse shouldInterceptRequest(')
    expect(activity).toContain('WardenAdBlock.isBlocked(url)')
    expect(activity).toContain('evaluateJavascript(WardenAdBlock.cosmeticScript()')
    expect(read(RULES)).toContain('public static boolean isBlocked(String url)')
  })

  it('ends the session when the surface closes', () => {
    const activity = read(ACTIVITY)
    expect(activity).toContain('cookies.removeAllCookies(null)')
    expect(activity).toContain('WebStorage.getInstance().deleteAllData()')
    expect(activity).toContain('webView.clearCache(true)')
    expect(activity).toContain('WebSettings.LOAD_NO_CACHE')
    expect(activity).toContain('setAcceptThirdPartyCookies(webView, false)')
  })
})

/**
 * Two native lists have to stay one list. They are written in different
 * languages on purpose — each platform's file reads like its own code — but a
 * host added to one and not the other is a page that is filtered on a phone and
 * not a tablet, which nobody would notice from a test suite that checked each
 * side against itself.
 */
describe('ad and tracker rules on both platforms', () => {
  const swiftList = (name: string): string[] => {
    const source = read(SWIFT_RULES)
    const start = source.indexOf(`static let ${name}`)
    expect(start, `${name} not found in the Swift rules`).toBeGreaterThan(-1)
    // From the opening bracket of the literal, not the one closing `[String]`.
    const open = source.indexOf('= [', start)
    const close = source.indexOf('\n    ]', open)
    expect(close, `${name} has no closing bracket`).toBeGreaterThan(open)
    return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
  }

  /**
   * One Java list, written as a run of `"host\n" +` literals. Each entry is the
   * literal with its trailing newline removed.
   */
  const javaList = (name: string): string[] => {
    const source = read(RULES)
    const start = source.indexOf(`List<String> ${name} = words(`)
    expect(start, `${name} not found in the Java rules`).toBeGreaterThan(-1)
    const end = source.indexOf(');', start)
    expect(end).toBeGreaterThan(start)
    return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) =>
      (match[1] ?? '').replace(/\\n$/, '')
    )
  }

  it('blocks the same ad hosts on iOS and Android', () => {
    expect(javaList('AD_HOSTS').sort()).toEqual([...swiftList('adHosts')].sort())
  })

  it('blocks the same tracker hosts on iOS and Android', () => {
    expect(javaList('TRACKER_HOSTS').sort()).toEqual([...swiftList('trackerHosts')].sort())
  })

  it('blocks the same path fragments on iOS and Android', () => {
    expect(javaList('PATH_FRAGMENTS').sort()).toEqual([...swiftList('pathFragments')].sort())
  })

  /** Yahoo's front page is the example that keeps coming up, so it is pinned. */
  it('covers the ad hosts a news front page actually calls', () => {
    const all = [...javaList('AD_HOSTS'), ...javaList('TRACKER_HOSTS')]
    for (const host of ['doubleclick.net', 'googlesyndication.com', 'gemini.yahoo.com', 'ads.yahoo.com']) {
      expect(all).toContain(host)
    }
  })
})

describe('the shell opens WARDEN, not another browser', () => {
  it('presents the in-app surface first and tells the caller which one ran', () => {
    const bridge = read('mobile/src/warden-browser.ts')
    expect(bridge).toContain("registerPlugin<WardenBrowserPlugin>('WardenBrowser')")
    expect(bridge).toContain('await WardenBrowser.open({ url })')
    expect(bridge).toContain('return')
  })

  it('claims only what the native surfaces implement', () => {
    const app = read('mobile/src/App.tsx')
    expect(app).toContain('A real engine')
    expect(app).toContain('Ad and tracker blocking')
    // The old copy said blocking was Phase 2. It is not any more.
    expect(app).not.toContain('Phase 2')
  })

  it('is called WARDEN Mobile on both stores', () => {
    expect(read('mobile/android/app/src/main/res/values/strings.xml')).toContain(
      '<string name="app_name">WARDEN Mobile</string>'
    )
    expect(read('mobile/ios/App/App/Info.plist')).toContain('<string>WARDEN Mobile</string>')
    expect(read('mobile/capacitor.config.ts')).toContain("appName: 'WARDEN Mobile'")
  })
})
